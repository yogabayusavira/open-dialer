import {
  createCipheriv,
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
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import pg from "pg";

const port = Number(process.env.PORT || 3000);
const root = process.cwd();
const storeDir = join(root, "data");
const storePath = join(storeDir, "callboard.json");
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
      .query(`
        CREATE TABLE IF NOT EXISTS callboard_state (
          id TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
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
    connection: stored.connection || null,
  };
}

function readFileState() {
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
      "SELECT payload FROM callboard_state WHERE id = $1",
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
        INSERT INTO callboard_state (id, payload, updated_at)
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
function encryptionKey() {
  const secret = process.env.CALLBOARD_ENCRYPTION_KEY;
  if (!secret || secret.length < 24)
    throw new Error(
      "CALLBOARD_ENCRYPTION_KEY must be set to a long random secret before saving credentials.",
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
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
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
  return process.env.CALLBOARD_ADMIN_PASSWORD || null;
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
  const token = cookies(req).callboard_session;
  const session = token && sessions.get(token);
  if (session && session.expiresAt > Date.now()) return true;
  if (token) sessions.delete(token);
  const remembered = cookies(req).callboard_remember;
  const [expiresAt, signature] = remembered?.split(".") || [];
  if (!/^\d{13}$/.test(expiresAt || "") || !signature) return false;
  if (Number(expiresAt) <= Date.now()) return false;
  const expected = createHmac("sha256", password)
    .update(`callboard-remember:${expiresAt}`)
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
      .update(`callboard-remember:${expiresAt}`)
      .digest("base64url");
    res.setHeader("set-cookie", [
      `callboard_remember=${expiresAt}.${signature}; ${cookieAttributes(rememberedSessionLifetimeMs / 1000)}`,
      `callboard_session=; ${cookieAttributes(0)}`,
    ]);
    return;
  }
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { expiresAt: Date.now() + sessionLifetimeMs });
  res.setHeader("set-cookie", [
    `callboard_session=${token}; ${cookieAttributes(sessionLifetimeMs / 1000)}`,
    `callboard_remember=; ${cookieAttributes(0)}`,
  ]);
}
function clearSession(req, res) {
  const token = cookies(req).callboard_session;
  if (token) sessions.delete(token);
  res.setHeader("set-cookie", [
    `callboard_session=; ${cookieAttributes(0)}`,
    `callboard_remember=; ${cookieAttributes(0)}`,
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
            "Set CALLBOARD_ADMIN_PASSWORD before using application sign-in.",
        });
      if (!canAttemptLogin(req))
        return json(res, 429, {
          error: "Too many sign-in attempts. Try again in 15 minutes.",
        });
      const body = await getBody(req);
      if (!safeEqual(body.password || "", password)) {
        recordFailedLogin(req);
        return json(res, 401, { error: "Incorrect Open Dialer password." });
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
          "CALLBOARD_ADMIN_PASSWORD must be configured before production use.",
      });
    if (url.pathname.startsWith("/api/") && !isAuthenticated(req))
      return json(res, 401, { error: "Sign in to access this workspace." });
    if (url.pathname === "/api/state" && req.method === "GET")
      return json(res, 200, safeState(await readState()));
    if (url.pathname === "/api/leads" && req.method === "POST") {
      const body = await getBody(req);
      if (!body.name?.trim() || !body.phone?.trim())
        return json(res, 400, {
          error: "A lead needs a name and phone number.",
        });
      const state = await readState();
      const lead = {
        id: `lead_${Date.now()}`,
        name: body.name.trim(),
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
        detail: `${lead.name} · ${lead.company}`,
      });
      await writeState(state);
      return json(res, 201, lead);
    }
    if (url.pathname.match(/^\/api\/leads\/[^/]+$/) && req.method === "PATCH") {
      const body = await getBody(req);
      const state = await readState();
      const lead = state.leads.find(
        (item) => item.id === url.pathname.split("/").pop(),
      );
      if (!lead) return json(res, 404, { error: "Lead not found." });
      if (typeof body.dnc === "boolean") {
        lead.dnc = body.dnc;
        lead.status = body.dnc ? "Paused" : "Ready";
        lead.note = body.dnc ? "Do not call: set from Open Dialer." : lead.note;
      }
      if (typeof body.status === "string") lead.status = body.status;
      state.activity.unshift({
        id: `event_${Date.now()}`,
        at: "Just now",
        action: lead.dnc ? "DNC suppression" : "Lead updated",
        detail: `${lead.name} · ${lead.company}`,
      });
      await writeState(state);
      return json(res, 200, lead);
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
    if (url.pathname === "/api/calls/prepare" && req.method === "POST") {
      const { leadId } = await getBody(req);
      const state = await readState();
      const lead = state.leads.find((item) => item.id === leadId);
      if (!lead) return json(res, 404, { error: "Lead not found." });
      if (lead.dnc)
        return json(res, 409, {
          error:
            "This contact is suppressed. Remove the DNC flag before preparing a call.",
        });
      if (!state.connection)
        return json(res, 409, {
          error: "Connect Twilio and select a number before preparing a call.",
        });
      return json(res, 409, {
        error:
          "Phone bridge setup is still required. Configure Twilio Voice webhooks before outbound calls can start.",
      });
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
