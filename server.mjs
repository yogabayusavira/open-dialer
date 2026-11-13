import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import pg from "pg";

const port = Number(process.env.PORT || 3000);
const root = process.cwd();
const storeDir = join(root, "data");
const storePath = join(storeDir, "open-dialer.json");
const distDir = join(root, "dist");
const databaseUrl = process.env.DATABASE_URL?.trim();
const database = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;
let databaseReady;
const sessions = new Map();
const loginAttempts = new Map();
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const rememberedSessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const loginWindowMs = 15 * 60 * 1000;
const loginLimit = 5;
const defaultState = {
  connection: null,
  opportunities: [],
  calls: [],
  dncNumbers: [],
  leads: [
    {
      id: "lead_1",
      name: "Marisol Vega",
      company: "Ridgefield Schools",
      role: "Operations Director",
      phone: "+1 425 555 0148",
      timezone: "America/Los_Angeles",
      status: "Ready",
      dnc: false,
      note: "Asked to reconnect after budget review.",
      due: "Now",
    },
    {
      id: "lead_2",
      name: "Arthur Coleman",
      company: "Westbridge Academy",
      role: "Principal",
      phone: "+1 312 555 0190",
      timezone: "America/Chicago",
      status: "Follow-up",
      dnc: false,
      note: "Requested a short overview by phone.",
      due: "10:30",
    },
    {
      id: "lead_3",
      name: "Priya Nair",
      company: "Northgate Charter",
      role: "Chief of Staff",
      phone: "+1 917 555 0173",
      timezone: "America/New_York",
      status: "Queued",
      dnc: false,
      note: "New import—verify contact details.",
      due: "11:15",
    },
    {
      id: "lead_4",
      name: "Theo Walker",
      company: "Harbor View Prep",
      role: "Head of Enrollment",
      phone: "+1 206 555 0141",
      timezone: "America/Los_Angeles",
      status: "Paused",
      dnc: true,
      note: "Do not call: requested removal on 2026-11-02.",
      due: "Suppressed",
    },
  ],
  activity: [
    {
      id: "event_1",
      at: "Today, 09:20",
      action: "Follow-up queued",
      detail: "Marisol Vega · Ridgefield Schools",
    },
    {
      id: "event_2",
      at: "Yesterday",
      action: "Outcome recorded",
      detail: "Arthur Coleman · requested a callback",
    },
    {
      id: "event_3",
      at: "Nov 06",
      action: "DNC suppression",
      detail: "Theo Walker · requested removal",
    },
  ],
};

async function databaseClient() {
  if (!database) return null;
  if (!databaseReady) {
    databaseReady = database
      // One-time migration from the previous product name. Safe to delete after the first deploy.
      .query(`
        DO $$ BEGIN
          IF to_regclass('callboard_state') IS NOT NULL AND to_regclass('open_dialer_state') IS NULL THEN
            ALTER TABLE callboard_state RENAME TO open_dialer_state;
          END IF;
        END $$;
      `)
      .then(() => database.query(`
        CREATE TABLE IF NOT EXISTS open_dialer_state (
          id TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `))
      .catch((error) => {
        databaseReady = undefined;
        throw error;
      });
  }
  await databaseReady;
  return database;
}

function normalizeState(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    return structuredClone(defaultState);
  return {
    ...structuredClone(defaultState),
    ...stored,
    leads: Array.isArray(stored.leads)
      ? stored.leads
      : structuredClone(defaultState.leads),
    activity: Array.isArray(stored.activity)
      ? stored.activity
      : structuredClone(defaultState.activity),
    opportunities: Array.isArray(stored.opportunities)
      ? stored.opportunities
      : [],
    calls: Array.isArray(stored.calls) ? stored.calls : [],
    dncNumbers: Array.isArray(stored.dncNumbers) ? stored.dncNumbers : [],
    connection: stored.connection || null,
  };
}

function readFileState() {
  // One-time migration from the previous product name. Safe to delete after the first run.
  const legacyPath = join(storeDir, "callboard.json");
  if (!existsSync(storePath) && existsSync(legacyPath)) renameSync(legacyPath, storePath);
  if (!existsSync(storePath)) return null;
  try {
    return normalizeState(JSON.parse(readFileSync(storePath, "utf8")));
  } catch {
    return null;
  }
}

async function readState() {
  const client = await databaseClient();
  if (client) {
    const result = await client.query(
      "SELECT payload FROM open_dialer_state WHERE id = $1",
      ["workspace"],
    );
    if (result.rows[0]) return normalizeState(result.rows[0].payload);
    const legacyState = readFileState();
    if (legacyState) {
      await writeState(legacyState);
      return legacyState;
    }
    return structuredClone(defaultState);
  }
  return readFileState() || structuredClone(defaultState);
}
async function writeState(state) {
  const client = await databaseClient();
  if (client) {
    await client.query(
      `
        INSERT INTO open_dialer_state (id, payload, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE
        SET payload = EXCLUDED.payload, updated_at = NOW()
      `,
      ["workspace", JSON.stringify(state)],
    );
    return;
  }
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(storePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}
function safeState(state) {
  const { authToken, tokenCiphertext, iv, tag, ...connection } =
    state.connection || {};
  return { ...state, connection: state.connection ? connection : null };
}
function activity(state, action, detail) {
  state.activity.unshift({
    id: `event_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    at: new Intl.DateTimeFormat("en", {
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date()),
    action,
    detail,
  });
  state.activity = state.activity.slice(0, 500);
}
function phoneKey(value) {
  return String(value || "").replace(/\D/g, "").slice(-15);
}
function leadLabel(lead) {
  return lead.name || (lead.company && lead.company !== "Unassigned" ? lead.company : "") || lead.phone;
}
const leadStatuses = ["Ready", "Try again", "Follow-up", "Closed", "Converted", "Paused"];
function cleanText(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function importedLeadRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error("The import has no rows. Choose a CSV and map a Phone column.");
  if (rows.length > 5000)
    throw new Error("Import at most 5,000 leads at a time. Split the CSV and import it in parts.");
  return rows.map((row) => {
    const details = {};
    if (row?.details && typeof row.details === "object" && !Array.isArray(row.details))
      for (const [key, value] of Object.entries(row.details).slice(0, 40)) {
        const label = cleanText(key, 60);
        const text = cleanText(value);
        if (label && text) details[label] = text;
      }
    return {
      name: cleanText(row?.name, 120),
      phone: cleanText(row?.phone, 40),
      company: cleanText(row?.company, 160) || "Unassigned",
      role: cleanText(row?.role, 120) || "Contact",
      timezone: cleanText(row?.timezone, 60) || "Unknown",
      note: cleanText(row?.note, 1000),
      details,
    };
  });
}
function encryptionKey() {
  const secret = process.env.OPEN_DIALER_ENCRYPTION_KEY;
  if (!secret || secret.length < 24)
    throw new Error(
      "OPEN_DIALER_ENCRYPTION_KEY must be set to a long random secret before saving credentials.",
    );
  return createHash("sha256").update(secret).digest();
}
function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return {
    tokenCiphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
function unseal(connection) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(connection.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(connection.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(connection.tokenCiphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
function publicOrigin(req) {
  const configured = process.env.OPEN_DIALER_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${protocol}://${req.headers.host}`;
}
function voiceToken(leadId, expiresAt) {
  const payload = `${leadId}.${expiresAt}`;
  return `${payload}.${createHmac("sha256", encryptionKey()).update(payload).digest("base64url")}`;
}
function validVoiceToken(token, leadId) {
  const [tokenLeadId, expiresAt, signature] = String(token || "").split(".");
  if (tokenLeadId !== leadId || !expiresAt || Number(expiresAt) < Date.now() || Number(expiresAt) > Date.now() + 11 * 60 * 1000 || !signature) return false;
  const payload = `${tokenLeadId}.${expiresAt}`;
  const expected = createHmac("sha256", encryptionKey()).update(payload).digest("base64url");
  return safeEqual(signature, expected);
}
function escapeXml(value) {
  return String(value).replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character]);
}
function twiml(res, source) {
  res.writeHead(200, { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" });
  res.end(source);
}
function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}
function getBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > 5_000_000) {
        tooLarge = true;
        raw = "";
      }
    });
    req.on("end", () => {
      if (tooLarge) return reject(new Error("That upload is too large. Split it into smaller files."));
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}
function configuredAdminPassword() {
  return process.env.OPEN_DIALER_ADMIN_PASSWORD || null;
}
function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((value) => value.trim().split("="))
      .filter(([key]) => key),
  );
}
function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function isAuthenticated(req) {
  const password = configuredAdminPassword();
  if (!password) return process.env.NODE_ENV !== "production";
  const token = cookies(req).open_dialer_session;
  const session = token && sessions.get(token);
  if (session && session.expiresAt > Date.now()) return true;
  if (token) sessions.delete(token);
  const remembered = cookies(req).open_dialer_remember;
  const [expiresAt, signature] = remembered?.split(".") || [];
  if (!/^\d{13}$/.test(expiresAt || "") || !signature) return false;
  if (Number(expiresAt) <= Date.now()) return false;
  const expected = createHmac("sha256", password)
    .update(`open-dialer-remember:${expiresAt}`)
    .digest("base64url");
  return safeEqual(signature, expected);
}
function cookieAttributes(maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}
function setSession(res, remember = false) {
  if (remember) {
    const expiresAt = String(Date.now() + rememberedSessionLifetimeMs);
    const signature = createHmac("sha256", configuredAdminPassword())
      .update(`open-dialer-remember:${expiresAt}`)
      .digest("base64url");
    res.setHeader("set-cookie", [
      `open_dialer_remember=${expiresAt}.${signature}; ${cookieAttributes(rememberedSessionLifetimeMs / 1000)}`,
      `open_dialer_session=; ${cookieAttributes(0)}`,
    ]);
    return;
  }
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { expiresAt: Date.now() + sessionLifetimeMs });
  res.setHeader("set-cookie", [
    `open_dialer_session=${token}; ${cookieAttributes(sessionLifetimeMs / 1000)}`,
    `open_dialer_remember=; ${cookieAttributes(0)}`,
  ]);
}
function clearSession(req, res) {
  const token = cookies(req).open_dialer_session;
  if (token) sessions.delete(token);
  res.setHeader("set-cookie", [
    `open_dialer_session=; ${cookieAttributes(0)}`,
    `open_dialer_remember=; ${cookieAttributes(0)}`,
  ]);
}
function requestKey(req) {
  return req.socket.remoteAddress || "unknown";
}
function canAttemptLogin(req) {
  const record = loginAttempts.get(requestKey(req));
  return !record || record.resetAt <= Date.now() || record.count < loginLimit;
}
function recordFailedLogin(req) {
  const key = requestKey(req);
  const existing = loginAttempts.get(key);
  const current =
    existing && existing.resetAt > Date.now()
      ? existing
      : { count: 0, resetAt: Date.now() + loginWindowMs };
  current.count += 1;
  loginAttempts.set(key, current);
}
function clearFailedLogins(req) {
  loginAttempts.delete(requestKey(req));
}
async function twilioNumbers(accountSid, authToken) {
  if (!/^AC[a-f0-9]{32}$/i.test(accountSid) || !authToken?.trim())
    throw new Error("Enter a valid Twilio Account SID and Auth Token.");
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=100`,
    { headers: { authorization: `Basic ${auth}` } },
  );
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Twilio rejected those credentials."
        : "Twilio could not list phone numbers right now.",
    );
  const data = await response.json();
  return (data.incoming_phone_numbers || [])
    .filter((number) => number.capabilities?.voice)
    .map((number) => ({
      sid: number.sid,
      number: number.phone_number,
      label: number.friendly_name || number.phone_number,
    }));
}
function mime(path) {
  return (
    {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
    }[extname(path)] || "application/octet-stream"
  );
}

createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    if (url.pathname === "/api/twilio/voice/connect" && req.method === "GET") {
      const leadId = url.searchParams.get("leadId");
      const token = url.searchParams.get("token");
      const state = await readState();
      const lead = state.leads.find((item) => item.id === leadId);
      if (!lead || lead.dnc || !validVoiceToken(token, lead.id))
        return twiml(res, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Hangup/></Response>");
      return twiml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${escapeXml(state.connection?.selectedNumber || "")}">${escapeXml(lead.phone)}</Dial></Response>`);
    }
    if (url.pathname === "/api/session" && req.method === "GET")
      return json(res, 200, {
        requiresAuth: Boolean(configuredAdminPassword()),
        authenticated: isAuthenticated(req),
      });
    if (url.pathname === "/api/session" && req.method === "POST") {
      const password = configuredAdminPassword();
      if (!password)
        return json(res, 400, {
          error:
            "Set OPEN_DIALER_ADMIN_PASSWORD before using application sign-in.",
        });
      if (!canAttemptLogin(req))
        return json(res, 429, {
          error: "Too many sign-in attempts. Try again in 15 minutes.",
        });
      const body = await getBody(req);
      if (!safeEqual(body.password || "", password)) {
        recordFailedLogin(req);
        return json(res, 401, { error: "Incorrect Open Dialer v2 password." });
      }
      clearFailedLogins(req);
      setSession(res, body.remember === true);
      return json(res, 204, {});
    }
    if (url.pathname === "/api/session" && req.method === "DELETE") {
      clearSession(req, res);
      return json(res, 204, {});
    }
    if (
      url.pathname.startsWith("/api/") &&
      process.env.NODE_ENV === "production" &&
      !configuredAdminPassword()
    )
      return json(res, 503, {
        error:
          "OPEN_DIALER_ADMIN_PASSWORD must be configured before production use.",
      });
    if (url.pathname.startsWith("/api/") && !isAuthenticated(req))
      return json(res, 401, { error: "Sign in to access this workspace." });
    if (url.pathname === "/api/state" && req.method === "GET")
      return json(res, 200, safeState(await readState()));
    if (url.pathname === "/api/leads" && req.method === "POST") {
      const body = await getBody(req);
      if (!phoneKey(body.phone))
        return json(res, 400, {
          error: "A lead needs a phone number.",
        });
      const state = await readState();
      const lead = {
        id: `lead_${Date.now()}_${randomBytes(3).toString("hex")}`,
        name: body.name?.trim() || "",
        company: body.company?.trim() || "Unassigned",
        role: body.role?.trim() || "Contact",
        phone: body.phone.trim(),
        timezone: body.timezone?.trim() || "Unknown",
        status: "Ready",
        dnc: false,
        note: "Added manually.",
        due: "Unscheduled",
      };
      state.leads.unshift(lead);
      state.activity.unshift({
        id: `event_${Date.now()}`,
        at: "Just now",
        action: "Lead added",
        detail: `${leadLabel(lead)} · ${lead.company}`,
      });
      await writeState(state);
      return json(res, 201, lead);
    }
    if (url.pathname === "/api/leads/import" && req.method === "POST") {
      const { leads } = await getBody(req);
      const imported = importedLeadRows(leads);
      const state = await readState();
      const known = new Set(state.leads.map((lead) => phoneKey(lead.phone)));
      let duplicates = 0;
      let invalid = 0;
      const created = imported.flatMap((candidate, index) => {
        const key = phoneKey(candidate.phone);
        if (key.length < 7) {
          invalid += 1;
          return [];
        }
        if (known.has(key)) {
          duplicates += 1;
          return [];
        }
        known.add(key);
        const dnc = state.dncNumbers.includes(key);
        return [{
          id: `lead_${Date.now()}_${index}`,
          ...candidate,
          status: dnc ? "Paused" : "Ready",
          dnc,
          note: dnc ? "Do not call: matched the workspace suppression list." : candidate.note || "Imported from CSV.",
          due: dnc ? "Suppressed" : "Unscheduled",
        }];
      });
      if (!created.length)
        return json(res, 409, {
          error: invalid === imported.length
            ? "None of the rows had a usable phone number. Check that the right column is mapped to Phone."
            : "Every row with a phone number is already in this workspace.",
          duplicates,
          invalid,
        });
      state.leads.unshift(...created);
      activity(state, "Leads imported", `${created.length} leads added from CSV`);
      await writeState(state);
      return json(res, 201, { imported: created.length, duplicates, invalid });
    }
    if (url.pathname === "/api/dnc" && req.method === "POST") {
      const { numbers } = await getBody(req);
      if (!Array.isArray(numbers) || numbers.length === 0)
        return json(res, 400, { error: "Add at least one phone number to suppress." });
      const state = await readState();
      const additions = [...new Set(numbers.map(phoneKey).filter((number) => number.length >= 7))];
      if (!additions.length) return json(res, 400, { error: "No valid phone numbers were found." });
      state.dncNumbers = [...new Set([...state.dncNumbers, ...additions])];
      let matched = 0;
      for (const lead of state.leads) {
        if (!additions.includes(phoneKey(lead.phone))) continue;
        lead.dnc = true;
        lead.status = "Paused";
        lead.due = "Suppressed";
        lead.note = "Do not call: matched the workspace suppression list.";
        matched += 1;
      }
      activity(state, "DNC list updated", `${additions.length} numbers suppressed; ${matched} existing leads updated`);
      await writeState(state);
      return json(res, 200, { suppressed: additions.length, matched });
    }
    if (url.pathname.match(/^\/api\/dnc\/[^/]+$/) && req.method === "DELETE") {
      const key = phoneKey(decodeURIComponent(url.pathname.split("/").pop()));
      const state = await readState();
      state.dncNumbers = state.dncNumbers.filter((number) => number !== key);
      for (const lead of state.leads) {
        if (phoneKey(lead.phone) !== key) continue;
        lead.dnc = false;
        lead.status = "Ready";
        lead.due = "Unscheduled";
      }
      activity(state, "DNC suppression removed", "A number was allowed again");
      await writeState(state);
      return json(res, 204, {});
    }
    if (url.pathname === "/api/leads/delete" && req.method === "POST") {
      const { ids } = await getBody(req);
      if (!Array.isArray(ids) || !ids.length) return json(res, 400, { error: "Choose at least one lead to delete." });
      const remove = new Set(ids.map(String));
      const state = await readState();
      const before = state.leads.length;
      state.leads = state.leads.filter((lead) => !remove.has(lead.id));
      const deleted = before - state.leads.length;
      activity(state, "Leads deleted", `${deleted} lead${deleted === 1 ? "" : "s"} removed`);
      await writeState(state);
      return json(res, 200, { deleted });
    }
    if (url.pathname.match(/^\/api\/leads\/[^/]+$/) && req.method === "PATCH") {
      const body = await getBody(req);
      const state = await readState();
      const lead = state.leads.find(
        (item) => item.id === url.pathname.split("/").pop(),
      );
      if (!lead) return json(res, 404, { error: "Lead not found." });
      if (typeof body.phone === "string") {
        const key = phoneKey(body.phone);
        if (key.length < 7) return json(res, 400, { error: "Enter a phone number with at least 7 digits." });
        if (state.leads.some((item) => item.id !== lead.id && phoneKey(item.phone) === key))
          return json(res, 409, { error: "Another lead already uses that phone number." });
        lead.phone = cleanText(body.phone, 40);
        if (state.dncNumbers.includes(key)) body.dnc = true;
      }
      if (typeof body.name === "string") lead.name = cleanText(body.name, 120);
      if (typeof body.company === "string") lead.company = cleanText(body.company, 160) || "Unassigned";
      if (typeof body.role === "string") lead.role = cleanText(body.role, 120) || "Contact";
      if (typeof body.timezone === "string") lead.timezone = cleanText(body.timezone, 60) || "Unknown";
      if (typeof body.note === "string") lead.note = cleanText(body.note, 1000);
      if (typeof body.dnc === "boolean") {
        lead.dnc = body.dnc;
        lead.status = body.dnc ? "Paused" : "Ready";
        lead.due = body.dnc ? "Suppressed" : "Unscheduled";
        if (body.dnc) lead.note = "Do not call: set from Open Dialer v2.";
      }
      if (typeof body.status === "string") {
        if (!leadStatuses.includes(body.status)) return json(res, 400, { error: "Choose a valid status." });
        lead.status = body.status;
        if (body.status !== "Follow-up" && lead.due !== "Suppressed") lead.due = body.status === "Closed" ? "Closed" : "Unscheduled";
      }
      if (typeof body.due === "string") lead.due = cleanText(body.due, 40) || "Unscheduled";
      activity(state, lead.dnc ? "DNC suppression" : "Lead updated", `${leadLabel(lead)} · ${lead.company}`);
      await writeState(state);
      return json(res, 200, lead);
    }
    if (url.pathname.match(/^\/api\/leads\/[^/]+$/) && req.method === "DELETE") {
      const state = await readState();
      const id = url.pathname.split("/").pop();
      const lead = state.leads.find((item) => item.id === id);
      if (!lead) return json(res, 404, { error: "Lead not found." });
      state.leads = state.leads.filter((item) => item.id !== id);
      activity(state, "Lead deleted", `${leadLabel(lead)} · ${lead.company}`);
      await writeState(state);
      return json(res, 204, {});
    }
    if (url.pathname === "/api/opportunities" && req.method === "POST") {
      const { leadId, name, value } = await getBody(req);
      const state = await readState();
      const lead = state.leads.find((item) => item.id === leadId);
      if (!lead) return json(res, 404, { error: "Lead not found." });
      const existing = state.opportunities.find((item) => item.leadId === lead.id);
      if (existing) return json(res, 409, { error: "This lead is already an opportunity." });
      const amount = Number(value || 0);
      if (!Number.isFinite(amount) || amount < 0)
        return json(res, 400, { error: "Opportunity value must be a positive number." });
      const opportunity = {
        id: `opp_${Date.now()}`,
        leadId: lead.id,
        name: String(name || `${lead.company} opportunity`).trim().slice(0, 120) || `${lead.company} opportunity`,
        company: lead.company,
        contact: lead.name || "",
        value: amount,
        stage: "Qualification",
        createdAt: new Date().toISOString(),
      };
      state.opportunities.unshift(opportunity);
      lead.status = "Converted";
      lead.due = "Converted";
      activity(state, "Lead converted", `${leadLabel(lead)} → ${opportunity.name}`);
      await writeState(state);
      return json(res, 201, opportunity);
    }
    if (url.pathname.match(/^\/api\/opportunities\/[^/]+$/) && req.method === "PATCH") {
      const body = await getBody(req);
      const state = await readState();
      const opportunity = state.opportunities.find((item) => item.id === url.pathname.split("/").pop());
      if (!opportunity) return json(res, 404, { error: "Opportunity not found." });
      const stages = ["Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost"];
      if (typeof body.stage === "string" && stages.includes(body.stage)) opportunity.stage = body.stage;
      if (body.value !== undefined) {
        const amount = Number(body.value);
        if (!Number.isFinite(amount) || amount < 0) return json(res, 400, { error: "Opportunity value must be a positive number." });
        opportunity.value = amount;
      }
      activity(state, "Opportunity updated", `${opportunity.name} · ${opportunity.stage}`);
      await writeState(state);
      return json(res, 200, opportunity);
    }
    if (url.pathname === "/api/calls/record" && req.method === "POST") {
      const { leadId, outcome, note, followUpAt } = await getBody(req);
      const state = await readState();
      const lead = state.leads.find((item) => item.id === leadId);
      if (!lead) return json(res, 404, { error: "Lead not found." });
      const outcomes = ["Interested", "Meeting booked", "Callback", "Maybe later", "No answer", "Busy", "Voicemail", "Not interested", "Wrong number", "Do not call"];
      if (!outcomes.includes(outcome)) return json(res, 400, { error: "Choose a valid call outcome." });
      const call = { id: `call_${Date.now()}`, leadId: lead.id, outcome, note: String(note || "").trim().slice(0, 1000), at: new Date().toISOString() };
      state.calls.unshift(call);
      if (outcome === "Do not call") {
        lead.dnc = true;
        lead.status = "Paused";
        lead.due = "Suppressed";
        state.dncNumbers = [...new Set([...state.dncNumbers, phoneKey(lead.phone)])];
      } else if (["Callback", "Interested", "Meeting booked", "Maybe later"].includes(outcome)) {
        lead.status = "Follow-up";
        lead.due = typeof followUpAt === "string" && followUpAt ? followUpAt : "Follow up";
      } else if (["Not interested", "Wrong number"].includes(outcome)) {
        lead.status = "Closed";
        lead.due = "Closed";
      } else lead.status = "Try again";
      if (call.note) lead.note = call.note;
      activity(state, "Call outcome recorded", `${leadLabel(lead)} · ${outcome}`);
      await writeState(state);
      return json(res, 201, call);
    }
    if (url.pathname === "/api/twilio/validate" && req.method === "POST") {
      const { accountSid, authToken } = await getBody(req);
      const numbers = await twilioNumbers(accountSid, authToken);
      return json(res, 200, { numbers });
    }
    if (url.pathname === "/api/twilio/connection" && req.method === "POST") {
      const { accountSid, authToken, number } = await getBody(req);
      if (!number?.sid || !number?.number)
        return json(res, 400, {
          error: "Choose a voice-capable number first.",
        });
      const verifiedNumber = (await twilioNumbers(accountSid, authToken)).find(
        (item) => item.sid === number.sid,
      );
      if (!verifiedNumber)
        return json(res, 400, {
          error:
            "That number is no longer available or is not voice-capable. Validate again and choose an eligible number.",
        });
      const state = await readState();
      state.connection = {
        accountSid,
        selectedNumberSid: verifiedNumber.sid,
        selectedNumber: verifiedNumber.number,
        selectedNumberLabel: verifiedNumber.label,
        connectedAt: new Date().toISOString(),
        ...seal(authToken),
      };
      state.activity.unshift({
        id: `event_${Date.now()}`,
        at: "Just now",
        action: "Telephony connected",
        detail: `Default line ${verifiedNumber.number}`,
      });
      await writeState(state);
      return json(res, 201, { connection: safeState(state).connection });
    }
    if (url.pathname === "/api/twilio/connection" && req.method === "DELETE") {
      const state = await readState();
      state.connection = null;
      state.activity.unshift({
        id: `event_${Date.now()}`,
        at: "Just now",
        action: "Telephony disconnected",
        detail: "Stored credentials removed",
      });
      await writeState(state);
      return json(res, 204, {});
    }
    if (url.pathname === "/api/twilio/connection" && req.method === "PATCH") {
      const { bridgeNumber } = await getBody(req);
      const normalized = String(bridgeNumber || "").trim();
      if (!/^\+?[1-9]\d{7,14}$/.test(normalized.replace(/[\s()-]/g, "")))
        return json(res, 400, { error: "Enter the operator phone number in international format, for example +15551234567." });
      const state = await readState();
      if (!state.connection) return json(res, 409, { error: "Connect Twilio before setting the calling bridge." });
      state.connection.bridgeNumber = normalized;
      activity(state, "Calling bridge configured", `Operator bridge ${normalized.slice(0, 4)}••••`);
      await writeState(state);
      return json(res, 200, { connection: safeState(state).connection });
    }
    if (url.pathname === "/api/calls/start" && req.method === "POST") {
      const { leadId } = await getBody(req);
      const state = await readState();
      const lead = state.leads.find((item) => item.id === leadId);
      if (!lead) return json(res, 404, { error: "Lead not found." });
      if (lead.dnc) return json(res, 409, { error: "This contact is suppressed and cannot be called." });
      if (!state.connection?.bridgeNumber)
        return json(res, 409, { error: "Save the operator phone number in Settings before starting a call." });
      const token = unseal(state.connection);
      const expiresAt = Date.now() + 10 * 60 * 1000;
      const voiceUrl = new URL("/api/twilio/voice/connect", publicOrigin(req));
      voiceUrl.searchParams.set("leadId", lead.id);
      voiceUrl.searchParams.set("token", voiceToken(lead.id, expiresAt));
      const auth = Buffer.from(`${state.connection.accountSid}:${token}`).toString("base64");
      const body = new URLSearchParams({
        To: state.connection.bridgeNumber,
        From: state.connection.selectedNumber,
        Url: voiceUrl.toString(),
        Method: "GET",
      });
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${state.connection.accountSid}/Calls.json`, {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) return json(res, 502, { error: "Twilio could not start the calling bridge. Check the selected number and operator phone number." });
      const remote = await response.json();
      state.calls.unshift({ id: `call_${Date.now()}`, leadId: lead.id, outcome: "In progress", note: "Calling bridge started.", at: new Date().toISOString(), sid: remote.sid });
      activity(state, "Call bridge started", `${leadLabel(lead)} · answer your bridge call to connect`);
      await writeState(state);
      return json(res, 201, { sid: remote.sid });
    }
    const requested =
      url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const file = normalize(join(distDir, requested));
    if (file.startsWith(distDir) && existsSync(file)) {
      res.writeHead(200, { "content-type": mime(file) });
      return createReadStream(file).pipe(res);
    }
    const index = join(distDir, "index.html");
    if (existsSync(index)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return createReadStream(index).pipe(res);
    }
    json(res, 404, {
      error: "Build the application before running the production server.",
    });
  } catch (error) {
    json(res, 400, {
      error:
        error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
}).listen(port, "0.0.0.0", () => console.log(`Open Dialer v2 listening on ${port}`));
