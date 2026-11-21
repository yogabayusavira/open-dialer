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
  rmSync,
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
      status: "New",
      campaigns: ["Demo"],
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
      campaigns: ["Demo"],
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
      status: "New",
      campaigns: ["Demo"],
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
      status: "Lost",
      campaigns: ["Demo"],
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
    leads: (Array.isArray(stored.leads) ? stored.leads : structuredClone(defaultState.leads))
      .map((lead) => migrateLead(lead, Array.isArray(stored.opportunities) ? stored.opportunities : []))
      .map((lead) => {
        if (lead.status !== "Follow-up" || lead.followUpSince) return lead;
        const reached = (Array.isArray(stored.calls) ? stored.calls : []).find((call) => call.leadId === lead.id && reachedOutcomes.includes(call.outcome));
        return { ...lead, followUpSince: reached?.at || "" };
      }),
    activity: Array.isArray(stored.activity)
      ? stored.activity
      : structuredClone(defaultState.activity),
    opportunities: Array.isArray(stored.opportunities)
      ? stored.opportunities
      : [],
    calls: Array.isArray(stored.calls) ? stored.calls : [],
    // Tasks you write yourself. Callbacks and meetings stay derived from leads.
    tasks: Array.isArray(stored.tasks) ? stored.tasks : [],
    // Per campaign: a pasted call script and, if uploaded, which PDF (the file itself is stored on its own).
    campaignSettings: stored.campaignSettings && typeof stored.campaignSettings === "object" && !Array.isArray(stored.campaignSettings) ? stored.campaignSettings : {},
    dncNumbers: Array.isArray(stored.dncNumbers) ? [...new Set(stored.dncNumbers.map(phoneKey))] : [],
    connection: stored.connection || null,
    settings: stored.settings && typeof stored.settings === "object" ? stored.settings : {},
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
    const query = () => client.query("SELECT payload FROM open_dialer_state WHERE id = $1", ["workspace"]);
    // A garbled read over the network surfaces as a JSON parse error; retry once before failing.
    const result = await query().catch((error) => {
      if (!(error instanceof SyntaxError)) throw error;
      console.error(`[open-dialer] workspace read came back garbled, retrying: ${error.message}`);
      return query();
    });
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
// Large files (script PDFs) live in their own rows/files so the workspace record stays small.
function blobPath(id) {
  return join(storeDir, "files", `${createHash("sha256").update(id).digest("hex")}.json`);
}
async function readBlob(id) {
  const client = await databaseClient();
  if (client) return (await client.query("SELECT payload FROM open_dialer_state WHERE id = $1", [id])).rows[0]?.payload || null;
  return existsSync(blobPath(id)) ? JSON.parse(readFileSync(blobPath(id), "utf8")) : null;
}
async function writeBlob(id, payload) {
  const client = await databaseClient();
  if (client) {
    if (payload === null) await client.query("DELETE FROM open_dialer_state WHERE id = $1", [id]);
    else await client.query("INSERT INTO open_dialer_state (id, payload, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()", [id, JSON.stringify(payload)]);
    return;
  }
  if (payload === null) return rmSync(blobPath(id), { force: true });
  mkdirSync(join(storeDir, "files"), { recursive: true });
  writeFileSync(blobPath(id), JSON.stringify(payload), { mode: 0o600 });
}
let stateQueue = Promise.resolve();
// Runs read-change-save steps one at a time, so requests arriving together (like Twilio's call reports)
// can't overwrite each other's changes. Return false from `change` to skip saving.
// shortcut: in-process only; several server instances would need a database row lock.
function updateState(change) {
  const run = stateQueue.then(async () => {
    const state = await readState();
    const result = await change(state);
    if (result !== false) await writeState(state);
    return result;
  });
  stateQueue = run.catch(() => {});
  return run;
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
  const { authToken, tokenCiphertext, iv, tag, apiKeySecret, ...connection } =
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
  // US numbers match with or without the leading country code 1.
  const digits = String(value || "").replace(/[\s,;]*(?:ext\.?|extension|x|#)\s*\d+\s*$/i, "").replace(/\D/g, "").slice(-15);
  return digits.length === 11 && digits[0] === "1" ? digits.slice(1) : digits;
}
function extensionDigits(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 10);
}
function leadLabel(lead) {
  return lead.name || (lead.company && lead.company !== "Unassigned" ? lead.company : "") || lead.phone;
}
// The pipeline: a lead's status is its stage. Lost is terminal; Do not call is a separate flag on top.
const leadStages = ["New", "Follow-up", "Meeting booked", "Won", "Lost"];
// Earlier statuses and stages, mapped once when a workspace is read.
const legacyStages = { Ready: "New", Queued: "New", "Try again": "New", Attempted: "New", Interested: "Follow-up", Closed: "Lost", Paused: "Lost" };
function migrateLead(lead, opportunities) {
  if (!leadStages.includes(lead.status)) {
    if (lead.status === "Converted") {
      // Leads converted under the old separate-opportunity pipeline take that opportunity's stage and value.
      const opportunity = opportunities.find((item) => item.leadId === lead.id);
      lead.status = opportunity?.stage === "Closed Won" ? "Won" : opportunity?.stage === "Closed Lost" ? "Lost" : "Meeting booked";
      if (opportunity && lead.value === undefined) lead.value = Number(opportunity.value) || 0;
      if (lead.due === "Converted") lead.due = "Unscheduled";
    } else lead.status = legacyStages[lead.status] || "New";
    if (lead.due === "Closed") lead.due = "Lost";
  }
  lead.campaigns = Array.isArray(lead.campaigns) ? lead.campaigns.map((name) => cleanText(name, 80)).filter(Boolean) : [];
  return lead;
}
// What a logged call outcome moves the lead to. No answer, busy and voicemail leave the stage alone;
// the rest only move a lead forward, except Lost.
const outcomeStage = { Callback: "Follow-up", "Maybe later": "Follow-up", Interested: "Follow-up", Voicemail: "Follow-up", "Meeting booked": "Meeting booked", "Not interested": "Lost", "Wrong number": "Lost", "Do not call": "Lost" };
const reachedOutcomes = ["Interested", "Meeting booked", "Callback", "Maybe later", "Not interested", "Wrong number", "Do not call"];
// Why a lead is being followed up, shown as a tag next to its follow-up number.
const followUpReasons = { Interested: "Interested", Callback: "Callback asked", "Maybe later": "Maybe later", Voicemail: "Voicemail left" };
// Follow-up numbers count calls made after this moment, so a lead entering Follow-up starts at "1 of 3".
function enterStage(lead, next) {
  if (next === "Follow-up" && lead.status !== "Follow-up") lead.followUpSince = new Date().toISOString();
  lead.status = next;
}
function stageAfterOutcome(current, outcome) {
  const next = outcomeStage[outcome];
  if (!next) return current;
  if (next === "Lost" || current === "Lost") return next;
  return leadStages.indexOf(next) > leadStages.indexOf(current) ? next : current;
}
function campaignName(value) {
  return cleanText(value, 80);
}
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
      extension: extensionDigits(row?.extension),
      company: cleanText(row?.company, 160) || "Unassigned",
      role: cleanText(row?.role, 120) || "Contact",
      timezone: cleanText(row?.timezone, 60) || "Unknown",
      note: cleanText(row?.note, 1000),
      // An optional Stage column ("Follow-up", "won", ...) places the lead on the board; anything else starts as New.
      status: leadStages.find((stage) => stage.toLowerCase() === cleanText(row?.stage, 40).toLowerCase()) || "New",
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
function twilioAuthHeader(connection) {
  return `Basic ${Buffer.from(`${connection.accountSid}:${unseal(connection)}`).toString("base64")}`;
}
async function twilioRequest(connection, path, params) {
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${connection.accountSid}${path}`, {
    method: "POST",
    headers: { authorization: twilioAuthHeader(connection), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Twilio: ${body.message || `request failed (${response.status})`}`);
  return body;
}
async function twilioGet(connection, url) {
  const response = await fetch(url, { headers: { authorization: twilioAuthHeader(connection) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `request failed (${response.status})`);
  return body;
}
function maskNumber(value) {
  const text = String(value || "");
  return text.length > 7 ? `${text.slice(0, 3)}${"•".repeat(text.length - 7)}${text.slice(-4)}` : text;
}
function base64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}
// Twilio access token (a signed JWT) that lets this browser place and receive calls for one hour.
function voiceAccessToken({ accountSid, keySid, keySecret, appSid, identity }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" });
  const payload = base64url({
    jti: `${keySid}-${now}`,
    iss: keySid,
    sub: accountSid,
    iat: now,
    exp: now + 3600,
    grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: appSid } } },
  });
  const signature = createHmac("sha256", keySecret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
const operatorIdentity = "operator";
function statusToken(leadId) {
  return createHmac("sha256", encryptionKey()).update(`call-status:${leadId}`).digest("base64url");
}
function getFormBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) req.destroy();
    });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(raw))));
    req.on("error", reject);
  });
}
const sipReasons = {
  403: "Twilio refused the call to your calling app (check SIP Registration and the credential list on the SIP domain)",
  404: "nobody is registered at that address (check the Zoiper username and domain)",
  408: "your calling app didn't respond in time",
  480: "your calling app is offline or not registered right now",
  486: "your calling app was busy",
  487: "the call was cancelled before your calling app answered",
  503: "your calling app's service was unavailable",
};
function describeCallResult(status, sipCode, errorCode, isSip, isLeadLeg = false) {
  if (isLeadLeg) {
    if (status === "completed") return "Call finished. Log the outcome for this lead.";
    if (status === "busy") return "The lead's line was busy.";
    if (status === "no-answer") return "The lead didn't answer.";
    if (status === "canceled") return "You hung up before the lead answered.";
    if (String(errorCode) === "13224") return "Didn't connect: Twilio won't dial this number (error 13224). It's invalid or can't take voice calls (for example a messaging-only number). Try another number for this lead. On a trial account, only verified numbers can be called.";
    return `Didn't connect: the lead's number couldn't be reached${sipCode ? ` (SIP ${sipCode})` : ""}${errorCode ? `, Twilio error ${errorCode}` : ""}.`;
  }
  const where = isSip ? "Your calling app" : "Your phone";
  if (status === "completed") return "Call finished. Log the outcome for this lead.";
  if (status === "busy") return `${where} was busy.`;
  if (status === "no-answer") return `${where} rang but nobody answered.`;
  if (status === "canceled") return "The call was cancelled before it connected.";
  const phoneReasons = { 404: "that number couldn't be reached (Twilio says it's invalid, not in service, or not supported)", 480: "that phone is switched off or out of reach", 403: "Twilio isn't allowed to call that number (check Voice geographic permissions)" };
  const reason = (!isSip && phoneReasons[sipCode]) || (sipCode && sipReasons[sipCode]) || (sipCode ? `the call failed (SIP ${sipCode})` : "the call failed");
  return `Didn't connect: ${reason}${sipCode ? ` (SIP ${sipCode})` : ""}${errorCode ? `, Twilio error ${errorCode}` : ""}.`;
}
function escapeXml(value) {
  return String(value).replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character]);
}
function twiml(res, source) {
  res.writeHead(200, { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" });
  res.end(source);
}
function json(res, status, payload) {
  // Every failed request is written to the server output (path only, never query tokens or bodies).
  if (status >= 400) console.error(`[open-dialer] ${status} ${res.req?.method || ""} ${new URL(res.req?.url || "/", "http://local").pathname}: ${payload?.error || ""}`);
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
      ".mjs": "text/javascript",
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
      return twiml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${escapeXml(state.connection?.selectedNumber || "")}"><Number${lead.extension ? ` sendDigits="wwww${extensionDigits(lead.extension)}"` : ""}>${escapeXml(lead.phone)}</Number></Dial></Response>`);
    }
    if (url.pathname === "/api/twilio/voice/status" && req.method === "POST") {
      const leadId = url.searchParams.get("leadId") || "";
      const token = url.searchParams.get("token") || "";
      if (!leadId || !safeEqual(token, statusToken(leadId))) return json(res, 403, { error: "Invalid status token." });
      const report = await getFormBody(req);
      const status = String(report.CallStatus || "");
      const sipCode = Number(report.SipResponseCode) || null;
      console.log(`[open-dialer] Twilio call …${String(report.CallSid || "").slice(-6)}: ${status}${sipCode ? ` (SIP ${sipCode})` : ""}${report.ErrorCode ? ` error ${report.ErrorCode}` : ""}`);
      const apply = (state) => {
        const call = state.calls.find((item) => item.sid && (item.sid === report.CallSid || item.sid === report.ParentCallSid) && item.leadId === leadId);
        if (!call) return false;
        const final = ["completed", "busy", "no-answer", "canceled", "failed"];
        // Reports can arrive out of order; never let an early event overwrite a final one.
        if (!final.includes(call.twilioStatus) || final.includes(status)) call.twilioStatus = status;
        if (sipCode) call.sipCode = sipCode;
        if (report.ParentCallSid && report.CallSid) call.leadLegSid = report.CallSid;
        if (report.ErrorCode) call.errorCode = String(report.ErrorCode);
        if (final.includes(status) && call.outcome === "In progress") {
          call.outcome = status === "completed" ? "Call ended" : "Didn't connect";
          call.note = describeCallResult(status, sipCode, report.ErrorCode, String(state.connection?.bridgeNumber || "").startsWith("sip:"), Boolean(report.ParentCallSid));
          const lead = state.leads.find((item) => item.id === leadId);
          activity(state, call.outcome, `${lead ? leadLabel(lead) : "Lead"} · ${call.note}`);
        }
        return true;
      };
      // A report can arrive before the call itself is saved; wait briefly and retry.
      for (let attempt = 0; attempt < 4 && (await updateState(apply)) === false; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 1500));
      return json(res, 200, {});
    }
    if (url.pathname === "/api/twilio/voice/client" && req.method === "POST") {
      const params = await getFormBody(req);
      const hangup = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
      const state = await readState();
      const lead = state.leads.find((item) => item.id === params.leadId);
      if (!lead || lead.dnc || !validVoiceToken(params.token, lead.id)) return twiml(res, hangup);
      await updateState((fresh) => {
        if (fresh.calls.some((item) => item.sid === params.CallSid)) return false;
        fresh.calls.unshift({ id: /^call_[\w]+$/.test(params.callId || "") ? params.callId : `call_${Date.now()}`, leadId: lead.id, outcome: "In progress", note: "Calling from the app.", at: new Date().toISOString(), sid: params.CallSid });
        activity(fresh, "Call started", `${leadLabel(lead)} · from the app`);
      });
      const statusUrl = new URL("/api/twilio/voice/status", publicOrigin(req));
      statusUrl.searchParams.set("leadId", lead.id);
      statusUrl.searchParams.set("token", statusToken(lead.id));
      const digits = lead.extension ? ` sendDigits="wwww${extensionDigits(lead.extension)}"` : "";
      return twiml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${escapeXml(state.connection?.selectedNumber || "")}" answerOnBridge="true"><Number${digits} statusCallback="${escapeXml(statusUrl.toString())}" statusCallbackMethod="POST" statusCallbackEvent="initiated ringing answered completed">${escapeXml(lead.phone)}</Number></Dial></Response>`);
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
      // callbackReachable tells the setup guide whether Twilio could fetch the call instructions from this app.
      return json(res, 200, { ...safeState(await readState()), callbackReachable: !/\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(publicOrigin(req)) });
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
        extension: extensionDigits(body.extension),
        timezone: body.timezone?.trim() || "Unknown",
        status: "New",
        campaigns: campaignName(body.campaign) ? [campaignName(body.campaign)] : [],
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
    if (url.pathname === "/api/campaigns/script" && req.method === "PUT") {
      const { campaign, script } = await getBody(req);
      const name = campaignName(campaign);
      if (!name) return json(res, 400, { error: "Choose a campaign." });
      const text = typeof script === "string" ? script.replace(/\r\n/g, "\n").trim().slice(0, 20000) : "";
      const state = await readState();
      if (!state.leads.some((lead) => lead.campaigns.includes(name))) return json(res, 404, { error: "That campaign has no leads." });
      state.campaignSettings[name] = { ...state.campaignSettings[name], script: text };
      activity(state, text ? "Script saved" : "Script removed", name);
      await writeState(state);
      return json(res, 200, state.campaignSettings[name]);
    }
    if (url.pathname === "/api/campaigns/script-pdf") {
      const name = campaignName(req.method === "GET" || req.method === "DELETE" ? url.searchParams.get("campaign") : "");
      const blobId = (campaign) => `script-pdf:${campaign}`;
      if (req.method === "GET") {
        const file = name && (await readBlob(blobId(name)));
        if (!file) return json(res, 404, { error: "No script PDF for this campaign." });
        // Shown inline in the app's viewer; never cached, since it can be replaced.
        res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `inline; filename="${String(file.name).replace(/[^\w .-]/g, "_")}"`, "cache-control": "no-store" });
        return res.end(Buffer.from(file.data, "base64"));
      }
      if (req.method === "POST") {
        const { campaign, fileName, data } = await getBody(req);
        const target = campaignName(campaign);
        if (!target) return json(res, 400, { error: "Choose a campaign." });
        const bytes = typeof data === "string" ? Buffer.from(data, "base64") : Buffer.alloc(0);
        if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return json(res, 400, { error: "That file isn't a PDF." });
        const state = await readState();
        if (!state.leads.some((lead) => lead.campaigns.includes(target))) return json(res, 404, { error: "That campaign has no leads." });
        const fileLabel = cleanText(fileName, 120) || "script.pdf";
        await writeBlob(blobId(target), { name: fileLabel, data: bytes.toString("base64") });
        state.campaignSettings[target] = { ...state.campaignSettings[target], pdf: { name: fileLabel, size: bytes.length, updatedAt: new Date().toISOString() } };
        activity(state, "Script PDF uploaded", `${target} · ${fileLabel}`);
        await writeState(state);
        return json(res, 200, state.campaignSettings[target]);
      }
      if (req.method === "DELETE") {
        if (!name) return json(res, 400, { error: "Choose a campaign." });
        await writeBlob(blobId(name), null);
        const state = await readState();
        if (state.campaignSettings[name]) delete state.campaignSettings[name].pdf;
        activity(state, "Script PDF removed", name);
        await writeState(state);
        return json(res, 200, state.campaignSettings[name] || {});
      }
    }
    if (url.pathname === "/api/tasks" && req.method === "POST") {
      const { title, details, due, leadId } = await getBody(req);
      const text = cleanText(title, 200);
      if (!text) return json(res, 400, { error: "Write what the task is." });
      const state = await readState();
      if (leadId && !state.leads.some((lead) => lead.id === leadId)) return json(res, 400, { error: "That lead no longer exists." });
      const task = { id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, title: text, details: cleanText(details, 4000), due: cleanText(due, 40), leadId: leadId || null, createdAt: new Date().toISOString(), doneAt: null };
      state.tasks.unshift(task);
      activity(state, "Task added", text);
      await writeState(state);
      return json(res, 201, task);
    }
    if (url.pathname.match(/^\/api\/tasks\/[^/]+$/) && (req.method === "PATCH" || req.method === "DELETE")) {
      const id = url.pathname.split("/")[3];
      const state = await readState();
      const task = state.tasks.find((item) => item.id === id);
      if (!task) return json(res, 404, { error: "Task not found." });
      if (req.method === "DELETE") {
        state.tasks = state.tasks.filter((item) => item.id !== id);
        activity(state, "Task deleted", task.title);
      } else {
        const { done, title, details, due, leadId } = await getBody(req);
        if (typeof done === "boolean") {
          task.doneAt = done ? new Date().toISOString() : null;
          activity(state, done ? "Task done" : "Task reopened", task.title);
        } else {
          // Edit: title, details, due and lead together, as the task dialog sends them.
          const text = cleanText(title, 200);
          if (!text) return json(res, 400, { error: "Write what the task is." });
          if (leadId && !state.leads.some((lead) => lead.id === leadId)) return json(res, 400, { error: "That lead no longer exists." });
          Object.assign(task, { title: text, details: cleanText(details, 4000), due: cleanText(due, 40), leadId: leadId || null });
          activity(state, "Task updated", task.title);
        }
      }
      await writeState(state);
      return json(res, 200, task);
    }
    if (url.pathname === "/api/leads/campaign" && req.method === "POST") {
      const { ids, campaign } = await getBody(req);
      const tag = campaignName(campaign);
      if (!tag) return json(res, 400, { error: "Type a campaign name first." });
      if (!Array.isArray(ids) || !ids.length) return json(res, 400, { error: "Select at least one lead." });
      const wanted = new Set(ids);
      const state = await readState();
      let added = 0;
      for (const lead of state.leads)
        if (wanted.has(lead.id) && !lead.campaigns.includes(tag)) { lead.campaigns.push(tag); added += 1; }
      if (added) {
        activity(state, "Leads tagged", `${added} leads added to ${tag}`);
        await writeState(state);
      }
      return json(res, 200, { added, already: wanted.size - added });
    }
    if (url.pathname === "/api/leads/import" && req.method === "POST") {
      const { leads, campaign } = await getBody(req);
      const tag = campaignName(campaign);
      const imported = importedLeadRows(leads);
      const state = await readState();
      const known = new Set(state.leads.map((lead) => phoneKey(lead.phone)));
      let duplicates = 0;
      let tagged = 0;
      let invalid = 0;
      const created = imported.flatMap((candidate, index) => {
        const key = phoneKey(candidate.phone);
        if (key.length < 7) {
          invalid += 1;
          return [];
        }
        if (known.has(key)) {
          duplicates += 1;
          const existing = tag && state.leads.find((lead) => phoneKey(lead.phone) === key);
          if (existing && !existing.campaigns.includes(tag)) { existing.campaigns.push(tag); tagged += 1; }
          return [];
        }
        known.add(key);
        const dnc = state.dncNumbers.includes(key);
        return [{
          id: `lead_${Date.now()}_${index}`,
          ...candidate,
          status: dnc ? "Lost" : candidate.status,
          ...(candidate.status === "Follow-up" && !dnc ? { followUpSince: new Date().toISOString() } : {}),
          campaigns: tag ? [tag] : [],
          dnc,
          note: dnc ? "Do not call: matched the workspace suppression list." : candidate.note,
          due: dnc ? "Suppressed" : ["Won", "Lost"].includes(candidate.status) ? candidate.status : "Unscheduled",
        }];
      });
      if (!created.length && tagged) {
        activity(state, "Leads tagged", `${tagged} existing leads added to ${tag}`);
        await writeState(state);
        return json(res, 201, { imported: 0, duplicates, invalid, tagged });
      }
      if (!created.length)
        return json(res, 409, {
          error: invalid === imported.length
            ? "None of the rows had a usable phone number. Check that the right column is mapped to Phone."
            : tag
              ? `Every row is already in this workspace and already in ${tag}.`
              // The usual reason to re-upload a file is to put its leads in a campaign, so say how.
              : `All ${duplicates} leads in this file are already in your workspace. To put them in a campaign, type a campaign name and import again.`,
          duplicates,
          invalid,
        });
      state.leads.unshift(...created);
      activity(state, "Leads imported", `${created.length} leads added from CSV${tag ? ` to ${tag}` : ""}`);
      await writeState(state);
      return json(res, 201, { imported: created.length, duplicates, invalid, tagged });
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
        lead.status = "Lost";
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
        lead.status = "New";
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
      if (typeof body.extension === "string") lead.extension = extensionDigits(body.extension);
      if (typeof body.name === "string") lead.name = cleanText(body.name, 120);
      if (typeof body.company === "string") lead.company = cleanText(body.company, 160) || "Unassigned";
      if (typeof body.role === "string") lead.role = cleanText(body.role, 120) || "Contact";
      if (typeof body.timezone === "string") lead.timezone = cleanText(body.timezone, 60) || "Unknown";
      if (typeof body.note === "string") lead.note = cleanText(body.note, 1000);
      if (typeof body.dnc === "boolean") {
        lead.dnc = body.dnc;
        lead.status = body.dnc ? "Lost" : "New";
        lead.due = body.dnc ? "Suppressed" : "Unscheduled";
        if (body.dnc) lead.note = "Do not call: set from Open Dialer v2.";
      }
      if (typeof body.status === "string") {
        if (!leadStages.includes(body.status)) return json(res, 400, { error: "Choose a valid stage." });
        enterStage(lead, body.status);
        if (lead.due !== "Suppressed" && ["Won", "Lost"].includes(body.status)) lead.due = body.status;
        else if (lead.due !== "Suppressed" && ["Won", "Lost"].includes(lead.due)) lead.due = "Unscheduled";
      }
      if (Array.isArray(body.campaigns)) lead.campaigns = [...new Set(body.campaigns.map(campaignName).filter(Boolean))];
      if (body.value !== undefined) {
        const amount = Number(body.value);
        if (!Number.isFinite(amount) || amount < 0) return json(res, 400, { error: "Deal value must be a positive number." });
        lead.value = amount;
      }
      if (typeof body.due === "string") lead.due = cleanText(body.due, 40) || "Unscheduled";
      activity(state, lead.dnc ? "DNC suppression" : "Lead updated", `${leadLabel(lead)} · ${lead.company}`);
      await writeState(state);
      return json(res, 200, lead);
    }
    if (url.pathname.match(/^\/api\/leads\/[^/]+\/task$/) && req.method === "POST") {
      const { done } = await getBody(req);
      const state = await readState();
      const lead = state.leads.find((item) => item.id === url.pathname.split("/")[3]);
      if (!lead) return json(res, 404, { error: "Lead not found." });
      if (done === true && !lead.taskDone) {
        lead.taskDone = { at: new Date().toISOString(), due: lead.due };
        lead.due = "Unscheduled";
        activity(state, "Task done", `${leadLabel(lead)} · ${lead.status}`);
      } else if (done === false && lead.taskDone) {
        lead.due = lead.taskDone.due;
        delete lead.taskDone;
        activity(state, "Task reopened", `${leadLabel(lead)} · ${lead.status}`);
      }
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
    if (url.pathname === "/api/calls/record" && req.method === "POST") {
      const { leadId, outcome, note, followUpAt } = await getBody(req);
      const state = await readState();
      const lead = state.leads.find((item) => item.id === leadId);
      if (!lead) return json(res, 404, { error: "Lead not found." });
      const outcomes = ["Interested", "Meeting booked", "Callback", "Maybe later", "No answer", "Busy", "Voicemail", "Not interested", "Wrong number", "Do not call"];
      if (!outcomes.includes(outcome)) return json(res, 400, { error: "Choose a valid call outcome." });
      const call = { id: `call_${Date.now()}`, leadId: lead.id, outcome, note: String(note || "").trim().slice(0, 1000), at: new Date().toISOString() };
      state.calls.unshift(call);
      enterStage(lead, stageAfterOutcome(lead.status, outcome));
      if (lead.status === "Follow-up" && followUpReasons[outcome]) lead.followUpReason = followUpReasons[outcome];
      delete lead.taskDone;
      const followUp = typeof followUpAt === "string" && followUpAt ? followUpAt : "";
      if (outcome === "Do not call") {
        lead.dnc = true;
        lead.due = "Suppressed";
        state.dncNumbers = [...new Set([...state.dncNumbers, phoneKey(lead.phone)])];
      } else if (lead.status === "Lost") lead.due = "Lost";
      else if (followUp) lead.due = followUp;
      else if (["Callback", "Maybe later", "Interested"].includes(outcome)) lead.due = "Follow up";
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
      const raw = String(bridgeNumber || "").trim();
      // Either a phone in international format or a softphone SIP address such as sip:bayu@example.sip.twilio.com.
      const isSip = /^sip:[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw);
      // "browser" = talk through this app's microphone and speaker.
      const isBrowser = raw === "browser";
      const normalized = isSip || isBrowser ? raw : raw.replace(/[\s()-]/g, "");
      if (!isSip && !isBrowser && !/^\+?[1-9]\d{7,14}$/.test(normalized))
        return json(res, 400, { error: "Enter your phone number with the country code, like +6281234567890, or your Zoiper address, like bayu@yourname.sip.twilio.com." });
      const state = await readState();
      if (!state.connection) return json(res, 409, { error: "Connect Twilio before setting the calling bridge." });
      state.connection.bridgeNumber = normalized;
      activity(state, "Calling bridge configured", isBrowser ? "Calls are taken in the app (microphone and speaker)" : isSip ? "Calls ring a SIP softphone first" : `Calls ring ${normalized.slice(0, 4)}•••• first`);
      await writeState(state);
      return json(res, 200, { connection: safeState(state).connection });
    }
    if (url.pathname.match(/^\/api\/calls\/[^/]+\/why$/) && req.method === "GET") {
      const state = await readState();
      const call = state.calls.find((item) => item.id === url.pathname.split("/")[3]);
      if (!call) return json(res, 404, { error: "Call not found." });
      if (!state.connection) return json(res, 409, { error: "Connect your Twilio account in Settings first." });
      const sids = [call.leadLegSid, call.sid].filter(Boolean);
      if (!sids.length) return json(res, 409, { error: "Twilio hasn't reported this call yet." });
      const alerts = [];
      for (const sid of sids) {
        const result = await twilioGet(state.connection, `https://monitor.twilio.com/v1/Alerts?ResourceSid=${encodeURIComponent(sid)}&PageSize=5`).catch((error) => ({ error: error.message }));
        if (result.error) return json(res, 502, { error: `Twilio wouldn't share its alerts with these credentials (${result.error}).` });
        for (const alert of result.alerts || []) {
          const params = new URLSearchParams(alert.alert_text || "");
          alerts.push({ code: alert.error_code, message: params.get("Msg") || params.get("msg") || alert.alert_text || "", moreInfo: alert.more_info || "", at: alert.date_created });
        }
      }
      return json(res, 200, { alerts });
    }
    if (url.pathname === "/api/settings" && req.method === "PATCH") {
      const { bookingUrl } = await getBody(req);
      const value = String(bookingUrl || "").trim();
      if (value) {
        let host = "";
        try {
          const parsed = new URL(value);
          host = parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : "";
        } catch {}
        if (!/(^|\.)calendly\.com$/.test(host) && !/(^|\.)cal\.com$/.test(host))
          return json(res, 400, { error: "Paste a Calendly or Cal.com link, for example https://calendly.com/your-name/30min or https://cal.com/your-name/30min." });
      }
      await updateState((state) => {
        state.settings = { ...(state.settings || {}), bookingUrl: value };
        activity(state, "Booking link updated", value ? "Book a call opens your scheduling page" : "Booking link removed");
      });
      return json(res, 200, { bookingUrl: value });
    }
    if (url.pathname === "/api/twilio/account-check" && req.method === "GET") {
      // Read-only look at the calling account, for people who only have its credentials, not Console access.
      const state = await readState();
      const connection = state.connection;
      if (!connection) return json(res, 409, { error: "Connect your Twilio account in Settings first." });
      const base = `https://api.twilio.com/2010-04-01/Accounts/${connection.accountSid}`;
      const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error: error.message }));
      const [account, verified, us] = await Promise.all([
        settle(twilioGet(connection, `${base}.json`)),
        settle(twilioGet(connection, `${base}/OutgoingCallerIds.json?PageSize=50`)),
        settle(twilioGet(connection, "https://voice.twilio.com/v1/DialingPermissions/Countries/US")),
      ]);
      const country = (result) => (result.error ? { error: result.error } : { allowed: Boolean(result.value.low_risk_numbers_enabled) });
      return json(res, 200, {
        account: account.error ? { error: account.error } : { type: account.value.type, status: account.value.status, name: account.value.friendly_name },
        verifiedNumbers: verified.error ? { error: verified.error } : { numbers: (verified.value.outgoing_caller_ids || []).map((item) => maskNumber(item.phone_number)) },
        countries: { US: country(us) },
      });
    }
    if (url.pathname === "/api/twilio/token" && req.method === "POST") {
      const state = await readState();
      const connection = state.connection;
      if (!connection) return json(res, 409, { error: "Connect your Twilio account in Settings first." });
      const voiceUrl = new URL("/api/twilio/voice/client", publicOrigin(req)).toString();
      // First use: create an API key and a TwiML app in the calling account, then keep them.
      if (!connection.apiKeySid || !connection.apiKeySecret) {
        const key = await twilioRequest(connection, "/Keys.json", { FriendlyName: "Open Dialer browser calling" });
        connection.apiKeySid = key.sid;
        connection.apiKeySecret = seal(key.secret);
      }
      if (!connection.twimlAppSid) {
        const app = await twilioRequest(connection, "/Applications.json", { FriendlyName: "Open Dialer browser calling", VoiceUrl: voiceUrl, VoiceMethod: "POST" });
        connection.twimlAppSid = app.sid;
        connection.twimlAppVoiceUrl = voiceUrl;
      } else if (connection.twimlAppVoiceUrl !== voiceUrl) {
        // The app's public address changed (for example a new tunnel); point Twilio at it.
        await twilioRequest(connection, `/Applications/${connection.twimlAppSid}.json`, { VoiceUrl: voiceUrl, VoiceMethod: "POST" });
        connection.twimlAppVoiceUrl = voiceUrl;
      }
      await updateState((fresh) => {
        if (!fresh.connection) return false;
        Object.assign(fresh.connection, { apiKeySid: connection.apiKeySid, apiKeySecret: connection.apiKeySecret, twimlAppSid: connection.twimlAppSid, twimlAppVoiceUrl: connection.twimlAppVoiceUrl });
      });
      const keySecret = unseal(connection.apiKeySecret);
      return json(res, 200, { token: voiceAccessToken({ accountSid: connection.accountSid, keySid: connection.apiKeySid, keySecret, appSid: connection.twimlAppSid, identity: operatorIdentity }) });
    }
    if (url.pathname === "/api/calls/browser-start" && req.method === "POST") {
      const { leadId } = await getBody(req);
      const state = await readState();
      const lead = state.leads.find((item) => item.id === leadId);
      if (!lead) return json(res, 404, { error: "Lead not found." });
      if (lead.dnc) return json(res, 409, { error: "This contact is suppressed and cannot be called." });
      if (!state.connection?.selectedNumber) return json(res, 409, { error: "Connect Twilio and pick an outbound number in Settings first." });
      // The call record is created when Twilio actually starts the call (voice/client), so a blocked
      // microphone or failed connection never leaves a call stuck "In progress".
      const callId = `call_${Date.now()}_${randomBytes(3).toString("hex")}`;
      return json(res, 201, { callId, leadId: lead.id, token: voiceToken(lead.id, Date.now() + 10 * 60 * 1000) });
    }
    if (url.pathname === "/api/calls/start" && req.method === "POST") {
      const { leadId } = await getBody(req);
      const state = await readState();
      const lead = state.leads.find((item) => item.id === leadId);
      if (!lead) return json(res, 404, { error: "Lead not found." });
      if (lead.dnc) return json(res, 409, { error: "This contact is suppressed and cannot be called." });
      if (!state.connection?.bridgeNumber || state.connection.bridgeNumber === "browser")
        return json(res, 409, { error: "This workspace takes calls in the app. Reload the page and press Call again." });
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
      const statusUrl = new URL("/api/twilio/voice/status", publicOrigin(req));
      statusUrl.searchParams.set("leadId", lead.id);
      statusUrl.searchParams.set("token", statusToken(lead.id));
      body.append("StatusCallback", statusUrl.toString());
      body.append("StatusCallbackMethod", "POST");
      for (const event of ["initiated", "ringing", "answered", "completed"]) body.append("StatusCallbackEvent", event);
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${state.connection.accountSid}/Calls.json`, {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        return json(res, 502, { error: `Twilio could not start the call${detail.message ? `: ${detail.message}` : ". Check the outbound number and where you answer calls."}` });
      }
      const remote = await response.json();
      await updateState((fresh) => {
        fresh.calls.unshift({ id: `call_${Date.now()}`, leadId: lead.id, outcome: "In progress", note: "Calling bridge started.", at: new Date().toISOString(), sid: remote.sid });
        activity(fresh, "Call bridge started", `${leadLabel(lead)} · answer your bridge call to connect`);
      });
      return json(res, 201, { sid: remote.sid });
    }
    const requested =
      url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const file = normalize(join(distDir, requested));
    // Built files have a hash in their name, so they can be cached for good; the page itself is always re-checked,
    // so a new build shows up on a normal refresh.
    if (file.startsWith(distDir) && existsSync(file)) {
      res.writeHead(200, { "content-type": mime(file), "cache-control": file.startsWith(join(distDir, "assets")) ? "public, max-age=31536000, immutable" : "no-cache" });
      return createReadStream(file).pipe(res);
    }
    const index = join(distDir, "index.html");
    if (existsSync(index)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
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
