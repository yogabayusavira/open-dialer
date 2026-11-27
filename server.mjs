import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
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
const loginAttempts = new Map();
// Each request runs with its signed-in user and their company's workspace id; storage reads and writes use it.
const requestContext = new AsyncLocalStorage();
// The workspace that existed before accounts keeps its original row id, so its data didn't have to move.
const legacyWorkspace = "workspace";
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

// Automations belong to the workspace; each trigger names its campaigns. Older ones lived in a campaign's
// settings, and the old voicemail drop (one variable, a recording per value) becomes one automation per value.
function takeAutomations(settings, stored) {
  const list = Array.isArray(stored) ? [...stored] : [];
  for (const [campaign, own] of Object.entries(settings)) {
    if (Array.isArray(own?.automations)) list.push(...own.automations.map((item) => ({ ...item, campaigns: [campaign] })));
    delete own?.automations;
    const use = own?.voicemail?.use;
    if (use && typeof use === "object") {
      const keys = Object.keys(use).sort((left, right) => (left === "*" ? 1 : right === "*" ? -1 : left.localeCompare(right)));
      list.push(...keys.map((key, index) => ({
        // Same id on every read until the converted settings are saved.
        id: `au_${String(use[key]).replace(/\W/g, "")}_${index}`,
        name: `${campaign}: ${key === "*" ? "voicemail for everyone else" : `voicemail if ${key}`}`,
        on: true,
        trigger: "voicemail",
        campaigns: [campaign],
        steps: [...(key === "*" || !own.voicemail.variable ? [] : [{ type: "if", field: own.voicemail.variable, op: "is", value: key }]), { type: "play", recordingId: use[key] }],
      })));
    }
    delete own?.voicemail;
  }
  return list;
}

function normalizeState(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    return structuredClone(defaultState);
  const settings = stored.campaignSettings && typeof stored.campaignSettings === "object" && !Array.isArray(stored.campaignSettings) ? stored.campaignSettings : {};
  return {
    ...structuredClone(defaultState),
    ...stored,
    automations: takeAutomations(settings, stored.automations),
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
    campaignSettings: settings,
    dncNumbers: Array.isArray(stored.dncNumbers) ? [...new Set(stored.dncNumbers.map(phoneKey))] : [],
    connection: stored.connection || null,
    settings: stored.settings && typeof stored.settings === "object" ? stored.settings : {},
    // The voicemail vault: recordings any campaign can use. The audio itself is stored on its own (voicemail-file:<id>).
    voicemails: Array.isArray(stored.voicemails) ? stored.voicemails : [],
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

function currentWorkspace() {
  const ws = requestContext.getStore()?.ws;
  if (!ws) throw new Error("Sign in to access this workspace.");
  return ws;
}
function workspaceFile(ws) {
  return ws === legacyWorkspace ? storePath : join(storeDir, `${ws}.json`);
}
// Database rows kept in memory: id → { at: updated_at in ms, payload }. A read first asks only when the row last
// changed (one quick round trip); the whole row (a workspace is ~0.5 MB, about a second over a far link) is fetched
// only when it changed, e.g. after another server or a script wrote it. Every read hands out its own copy.
const rowCache = new Map();
async function readRow(client, id) {
  const head = await client.query("SELECT updated_at FROM open_dialer_state WHERE id = $1", [id]);
  if (!head.rows[0]) {
    rowCache.delete(id);
    return null;
  }
  const hit = rowCache.get(id);
  if (hit && hit.at === new Date(head.rows[0].updated_at).getTime()) return structuredClone(hit.payload);
  const query = () => client.query("SELECT payload, updated_at FROM open_dialer_state WHERE id = $1", [id]);
  // A garbled read over the network surfaces as a JSON parse error; retry once before failing.
  const result = await query().catch((error) => {
    if (!(error instanceof SyntaxError)) throw error;
    console.error(`[open-dialer] read of ${id} came back garbled, retrying: ${error.message}`);
    return query();
  });
  const row = result.rows[0];
  if (!row) return null;
  rowCache.set(id, { at: new Date(row.updated_at).getTime(), payload: row.payload });
  return structuredClone(row.payload);
}
async function writeRow(client, id, payload) {
  const result = await client.query(
    "INSERT INTO open_dialer_state (id, payload, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW() RETURNING updated_at",
    [id, JSON.stringify(payload)],
  );
  rowCache.set(id, { at: new Date(result.rows[0].updated_at).getTime(), payload: structuredClone(payload) });
}
async function readState() {
  const ws = currentWorkspace();
  const client = await databaseClient();
  if (client) {
    const payload = await readRow(client, ws);
    if (payload) return normalizeState(payload);
    if (ws !== legacyWorkspace) return normalizeState({ leads: [], activity: [] });
    const legacyState = readFileState();
    if (legacyState) {
      await writeState(legacyState);
      return legacyState;
    }
    return structuredClone(defaultState);
  }
  if (ws !== legacyWorkspace) {
    try { return normalizeState(JSON.parse(readFileSync(workspaceFile(ws), "utf8"))); } catch { return normalizeState({ leads: [], activity: [] }); }
  }
  return readFileState() || structuredClone(defaultState);
}
// Large files (script PDFs) live in their own rows/files so the workspace record stays small.
function blobPath(id) {
  return join(storeDir, "files", `${createHash("sha256").update(id).digest("hex")}.json`);
}
async function readBlob(id) {
  const client = await databaseClient();
  if (client) return readRow(client, id);
  return existsSync(blobPath(id)) ? JSON.parse(readFileSync(blobPath(id), "utf8")) : null;
}
async function writeBlob(id, payload) {
  const client = await databaseClient();
  if (client) {
    if (payload === null) {
      await client.query("DELETE FROM open_dialer_state WHERE id = $1", [id]);
      rowCache.delete(id);
    } else await writeRow(client, id, payload);
    return;
  }
  if (payload === null) return rmSync(blobPath(id), { force: true });
  mkdirSync(join(storeDir, "files"), { recursive: true });
  writeFileSync(blobPath(id), JSON.stringify(payload), { mode: 0o600 });
}
let stateQueue = Promise.resolve();
// Runs changes one at a time, so two users (or Twilio's call reports) can't overwrite each other's saves.
// Every changing API request runs inside this; nested calls from the same request run straight through.
// shortcut: in-process only; several server instances would need a database row lock.
function exclusive(fn) {
  const store = requestContext.getStore();
  if (store?.locked) return fn();
  const run = stateQueue.then(() => requestContext.run({ ...store, locked: true }, fn));
  stateQueue = run.catch(() => {});
  return run;
}
// Return false from `change` to skip saving.
function updateState(change) {
  return exclusive(async () => {
    const state = await readState();
    const result = await change(state);
    if (result !== false) await writeState(state);
    return result;
  });
}
async function writeState(state) {
  const client = await databaseClient();
  if (client) {
    await writeRow(client, currentWorkspace(), state);
    return;
  }
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(workspaceFile(currentWorkspace()), JSON.stringify(state, null, 2), { mode: 0o600 });
}
// Users and companies, kept in one record of their own. Passwords are stored only as scrypt hashes.
async function readAccounts() {
  const stored = await readBlob("accounts");
  return { users: Array.isArray(stored?.users) ? stored.users : [], workspaces: Array.isArray(stored?.workspaces) ? stored.workspaces : [] };
}
function updateAccounts(change) {
  return exclusive(async () => {
    const accounts = await readAccounts();
    const result = await change(accounts);
    if (result !== false) await writeBlob("accounts", accounts);
    return result;
  });
}
function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, 64).toString("base64")}`;
}
function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  return timingSafeEqual(scryptSync(String(password), Buffer.from(salt, "base64"), 64), Buffer.from(hash, "base64"));
}
function validPassword(password) {
  return typeof password === "string" && password.length >= 10 && password.length <= 200;
}
function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200 ? email : "";
}
function publicUser(user, withEmail = true) {
  return { id: user.id, name: user.name, role: user.role, ...(withEmail ? { email: user.email, pending: !user.passwordHash } : {}), ...(user.admin ? { admin: true } : {}) };
}
// Sign-in links (invites and password resets) go in the URL; only their hash is stored.
const linkLifetimeMs = { invite: 7 * 24 * 60 * 60 * 1000, reset: 60 * 60 * 1000 };
function tokenHash(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}
function giveLink(user, kind) {
  const token = randomBytes(32).toString("base64url");
  user.link = { hash: tokenHash(token), kind, expiresAt: Date.now() + linkLifetimeMs[kind] };
  return token;
}
function userForLink(accounts, token) {
  const hash = tokenHash(token);
  return accounts.users.find((item) => item.link && item.link.expiresAt > Date.now() && safeEqual(item.link.hash, hash)) || null;
}
// Links in emails use the configured public address, never the request's Host header.
function appUrl(req) {
  const configured = process.env.OPEN_DIALER_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") throw new Error("Set OPEN_DIALER_PUBLIC_URL so sign-in links point at this app.");
  return `http://${req.headers.host}`;
}
// What's switched on in Settings → Features & costs. Anything not saved yet keeps its default.
const featureDefaults = { transcription: false, captions: true, saveTranscripts: true, ai: true, email: true, sms: true };
function features(state) {
  return { ...featureDefaults, ...(state?.settings?.features || {}) };
}
// Email goes out through the workspace's own Resend key and sender (Settings → Email); the server's .env is the fallback.
function emailConfig(state) {
  if (!features(state).email) return null;
  if (state?.email?.key && state.email.from) return { key: unseal(state.email.key), from: state.email.from };
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) return { key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM_EMAIL };
  return null;
}
function emailReady(state) {
  return Boolean(emailConfig(state));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
// Sends one email through Resend. Returns false when email isn't set up, so the caller can show the link instead.
async function sendEmail(config, to, subject, lines, button) {
  if (!config) return false;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}<p><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4a0d72;color:#fff;text-decoration:none;font-weight:600">${escapeHtml(button.label)}</a></p><p style="color:#666;font-size:13px">Or paste this link into your browser: ${escapeHtml(button.url)}</p></div>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: config.from, to: [to], subject, html, text: `${lines.join("\n\n")}\n\n${button.label}: ${button.url}` }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`The email didn't send (Resend: ${detail.message || response.status}).`);
  }
  return true;
}
async function sendInvite(req, user, token, invitedBy, company) {
  const url = `${appUrl(req)}/#welcome/${token}`;
  const config = emailConfig(await readState());
  return emailOrLink(url, () => sendEmail(config, user.email, `${invitedBy} invited you to ${company} on Open Dialer`, [`Hi ${user.name},`, `${invitedBy} added you to ${company} on Open Dialer. Set a password to sign in. This link works for 7 days.`], { label: "Set your password", url }));
}
async function sendReset(req, user, token) {
  const url = `${appUrl(req)}/#welcome/${token}`;
  const config = emailConfig(await readState());
  return emailOrLink(url, () => sendEmail(config, user.email, "Reset your Open Dialer password", [`Hi ${user.name},`, "Use this link to choose a new password. It works for 1 hour. If you didn't ask for this, you can ignore this email."], { label: "Choose a new password", url }));
}
// If the email can't go out (not set up, or Resend refuses), hand back the link so the owner can pass it on.
async function emailOrLink(url, send) {
  try {
    if (await send()) return { emailed: true };
    return { emailed: false, link: url };
  } catch (error) {
    console.error(`[open-dialer] ${error.message}`);
    return { emailed: false, link: url, emailError: error.message };
  }
}
// ---- AI cleanup of script variables ----
// Each company saves its own key in Settings (encrypted like the Twilio token); a key in .env is the fallback.
const aiProviders = {
  groq: { name: "Groq", url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-20b" },
  openrouter: { name: "OpenRouter", url: "https://openrouter.ai/api/v1/chat/completions", model: "google/gemma-4-26b-a4b-it:free" },
};
function aiConfig(state) {
  if (!features(state).ai) return null;
  if (state.ai?.key) {
    const provider = aiProviders[state.ai.provider] ? state.ai.provider : "groq";
    return { provider, model: state.ai.model || aiProviders[provider].model, key: unseal(state.ai.key) };
  }
  if (process.env.GROQ_API_KEY) return { provider: "groq", model: aiProviders.groq.model, key: process.env.GROQ_API_KEY };
  if (process.env.OPENROUTER_API_KEY) return { provider: "openrouter", model: aiProviders.openrouter.model, key: process.env.OPENROUTER_API_KEY };
  return null;
}
async function aiChat(config, system, user) {
  const response = await fetch(aiProviders[config.provider].url, {
    method: "POST",
    headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      // gpt-oss models think before answering; keep that short so replies stay fast.
      ...(config.model.startsWith("openai/gpt-oss") && config.provider === "groq" ? { reasoning_effort: "low" } : {}),
    }),
    signal: AbortSignal.timeout(25000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${aiProviders[config.provider].name}: ${body.error?.message || `error ${response.status}`}`);
  return String(body.choices?.[0]?.message?.content || "");
}
function forgetSpoken(state, campaign, variable) {
  let count = 0;
  for (const lead of state.leads) {
    if (lead.campaigns?.includes(campaign) && lead.spoken?.[variable]) {
      delete lead.spoken[variable];
      count++;
    }
  }
  return count;
}
// Rewrites each { variable, text } the way the campaign's example and notes say. Returns texts in the same order.
async function aiClean(config, rules, items) {
  const system = "You prepare lead data for a sales caller to read aloud in a phone script. Rewrite each item so it sounds natural when spoken, following that variable's example and notes exactly. Keep the facts, never invent anything, and drop asides that would distract the caller. Reply with only JSON: {\"results\": [\"…\", …]} with one string per item, in order.";
  const user = JSON.stringify({
    rules: Object.fromEntries(Object.entries(rules).map(([name, rule]) => [name, { example: rule.from && rule.to ? { raw: rule.from, say: rule.to } : undefined, notes: rule.notes || undefined }])),
    items: items.map((item) => ({ variable: item.variable, raw: item.text })),
  });
  const reply = await aiChat(config, system, user);
  const match = reply.match(/\{[\s\S]*\}/);
  const results = match ? JSON.parse(match[0]).results : null;
  if (!Array.isArray(results) || results.length !== items.length) throw new Error("The AI's answer couldn't be read. Try again.");
  return results.map((text) => cleanText(String(text ?? ""), 500));
}

function currentUser() {
  return requestContext.getStore()?.user || null;
}
function isOwner() {
  return currentUser()?.role === "owner";
}
// Callers only see leads assigned to them; owners see the whole workspace.
function canSee(lead) {
  return Boolean(lead) && (isOwner() || lead.assignedTo === currentUser()?.id);
}
function findLead(state, id) {
  const lead = state.leads.find((item) => item.id === id);
  return canSee(lead) ? lead : undefined;
}
// What one user gets from GET /api/state.
function visibleState(state) {
  if (isOwner()) return state;
  const leadIds = new Set(state.leads.filter(canSee).map((lead) => lead.id));
  const campaigns = new Set(state.leads.filter(canSee).flatMap((lead) => lead.campaigns || []));
  return {
    ...state,
    leads: state.leads.filter(canSee),
    calls: state.calls.filter((call) => leadIds.has(call.leadId)),
    opportunities: state.opportunities.filter((item) => leadIds.has(item.leadId)),
    tasks: state.tasks.filter((task) => task.userId === currentUser().id),
    campaignSettings: Object.fromEntries(Object.entries(state.campaignSettings).filter(([name]) => campaigns.has(name))),
    activity: [],
    dncNumbers: [],
  };
}
// Blob ids for the original workspace stay as they were; other companies' are prefixed with their id.
function scopedBlob(id) {
  const ws = currentWorkspace();
  return ws === legacyWorkspace ? id : `${ws}:${id}`;
}
function safeState(state) {
  const { authToken, tokenCiphertext, iv, tag, apiKeySecret, ...connection } =
    state.connection || {};
  // The AI key never leaves the server; the app only learns whether AI is ready and the key's last characters.
  const { key, ...ai } = state.ai || {};
  const { key: emailKey, ...email } = state.email || {};
  return { ...state, connection: state.connection ? connection : null, ai: { ...ai, ready: Boolean(key || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY) }, email: { ...email, saved: Boolean(emailKey), envFallback: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) } };
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
const callOutcomes = ["Interested", "Meeting booked", "Callback", "Maybe later", "No answer", "Busy", "Voicemail", "Not interested", "Wrong number", "Do not call"];
// The workspace's automations, as sent by the Automations page: a trigger (with the campaigns it listens to, none
// meaning any) and a graph of nodes, n8n style. Each connection goes from a node's output ("out", or "yes"/"no" on an
// If) to another node; an output can feed several nodes, and every connected branch runs.
const automationTriggers = ["lead", "outcome", "voicemail", "transcribed"];
const conditionOps = ["is", "is not", "contains", "is empty", "is not empty"];
const flowPorts = ["out", "yes", "no"];
function cleanStep(step, trigger) {
  if (step?.type === "if") return { type: "if", field: cleanText(step.field, 120), op: conditionOps.includes(step.op) ? step.op : "is", value: cleanText(step.value, 200) };
  if (step?.type === "say" && trigger === "lead") return { type: "say", text: cleanText(step.text, 1000) };
  if (step?.type === "play" && trigger === "voicemail") return { type: "play", recordingId: /^vm_\w+$/.test(step.recordingId || "") ? step.recordingId : "" };
  const later = trigger === "outcome" || trigger === "transcribed";
  if (step?.type === "wait" && later) return { type: "wait", amount: Math.min(365, Math.max(1, Math.round(Number(step.amount) || 1))), unit: ["minutes", "hours", "days"].includes(step.unit) ? step.unit : "days" };
  if (step?.type === "email" && later) return { type: "email", to: cleanText(step.to, 120), subject: cleanText(step.subject, 200), body: String(step.body || "").replace(/\r\n/g, "\n").slice(0, 5000) };
  if (step?.type === "sms" && later) return { type: "sms", text: String(step.text || "").replace(/\r\n/g, "\n").slice(0, 640) };
  if (step?.type === "ask" && trigger === "transcribed") return { type: "ask", prompt: cleanText(step.prompt, 1000), field: cleanText(step.field, 60) };
  if (step?.type === "stage" && later) return { type: "stage", stage: leadStages.includes(step.stage) ? step.stage : "Follow-up" };
  if (step?.type === "followup" && later) return { type: "followup", days: Math.min(60, Math.max(0, Math.round(Number(step.days) || 0))) };
  return null;
}
// An automation's graph. Ones saved before the graph editor (a list of steps) become a left-to-right chain, with an
// If's "yes" carrying on, which is how the old "Only continue if" behaved.
function flowGraph(item) {
  if (Array.isArray(item?.nodes) && item.nodes.length) return { nodes: item.nodes, edges: Array.isArray(item.edges) ? item.edges : [] };
  const steps = Array.isArray(item?.steps) ? item.steps : [];
  const nodes = [{ id: "trigger", step: null, x: 0, y: 0 }, ...steps.map((step, index) => ({ id: `s${index}`, step, x: (index + 1) * 300, y: 0 }))];
  const edges = steps.map((_, index) => ({ from: index ? `s${index - 1}` : "trigger", port: index && steps[index - 1]?.type === "if" ? "yes" : "out", to: `s${index}` }));
  return { nodes, edges };
}
// Whether `start` can already reach `target` through the connections; a connection target -> start would be a loop.
function flowReaches(edges, start, target) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop();
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of edges) if (edge.from === id) stack.push(edge.to);
  }
  return false;
}
function cleanAutomations(list) {
  return list.slice(0, 50).map((item) => {
    const trigger = automationTriggers.includes(item?.trigger) ? item.trigger : "lead";
    const graph = flowGraph(item);
    const nodes = [];
    for (const node of graph.nodes.slice(0, 60)) {
      const id = /^[\w-]{1,40}$/.test(node?.id || "") ? node.id : "";
      if (!id || nodes.some((entry) => entry.id === id)) continue;
      const isTrigger = id === "trigger";
      const step = isTrigger ? null : cleanStep(node.step, trigger);
      if (!isTrigger && !step) continue;
      nodes.push({ id, step, x: Math.round(Number(node.x) || 0), y: Math.round(Number(node.y) || 0) });
    }
    if (!nodes.some((node) => node.id === "trigger")) nodes.unshift({ id: "trigger", step: null, x: 0, y: 0 });
    const edges = [];
    for (const edge of graph.edges.slice(0, 200)) {
      const source = nodes.find((node) => node.id === edge?.from);
      const target = nodes.find((node) => node.id === edge?.to);
      const port = flowPorts.includes(edge?.port) ? edge.port : "out";
      // Only an If has yes/no; nothing connects into the trigger, to itself, twice, or back into a loop.
      if (!source || !target || target.id === "trigger" || source.id === target.id) continue;
      if ((source.step?.type === "if") !== (port !== "out")) continue;
      if (edges.some((entry) => entry.from === source.id && entry.port === port && entry.to === target.id)) continue;
      if (flowReaches(edges, target.id, source.id)) continue;
      edges.push({ from: source.id, port, to: target.id });
    }
    return {
      id: /^au_\w+$/.test(item?.id || "") ? item.id : `au_${Date.now()}_${randomBytes(3).toString("hex")}`,
      name: cleanText(item?.name, 80) || "Untitled automation",
      on: item?.on !== false,
      trigger,
      campaigns: (Array.isArray(item?.campaigns) ? item.campaigns : []).map(campaignName).filter(Boolean).slice(0, 50),
      ...(trigger === "outcome" || trigger === "transcribed" ? { outcomes: (Array.isArray(item?.outcomes) ? item.outcomes : []).filter((outcome) => callOutcomes.includes(outcome)) } : {}),
      nodes,
      edges,
    };
  });
}
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
  // When it was won, so the dashboard can count deals won today and this month.
  if (next === "Won" && lead.status !== "Won") lead.wonAt = new Date().toISOString();
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
// A recording's organizing labels: the campaigns it's for (tags only, nothing is restricted by them) and what it says,
// so it can be picked without listening. Only fields sent are returned, so a PATCH changes just those.
function voicemailLabels(body) {
  const labels = {};
  if (Array.isArray(body.campaigns)) labels.campaigns = [...new Set(body.campaigns.map((name) => cleanText(name, 80)).filter(Boolean))].slice(0, 20);
  if (typeof body.says === "string") labels.says = cleanText(body.says, 500);
  return labels;
}
function cleanText(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
// Custom fields and CSV columns live in lead.details; a blank value removes the field from the lead.
function applyDetails(lead, details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return;
  for (const [key, value] of Object.entries(details).slice(0, 40)) {
    const label = cleanText(key, 60);
    if (!label) continue;
    const text = cleanText(value);
    lead.details = lead.details || {};
    if (text) lead.details[label] = text;
    else delete lead.details[label];
  }
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
  const payload = `${currentWorkspace()}.${leadId}.${expiresAt}`;
  return `${payload}.${createHmac("sha256", encryptionKey()).update(payload).digest("base64url")}`;
}
// Returns the token's workspace when it is valid for this lead, otherwise null.
function voiceTokenWorkspace(token, leadId) {
  const [ws, tokenLeadId, expiresAt, signature] = String(token || "").split(".");
  if (!ws || tokenLeadId !== leadId || !expiresAt || Number(expiresAt) < Date.now() || Number(expiresAt) > Date.now() + 11 * 60 * 1000 || !signature) return null;
  const payload = `${ws}.${tokenLeadId}.${expiresAt}`;
  const expected = createHmac("sha256", encryptionKey()).update(payload).digest("base64url");
  return safeEqual(signature, expected) ? ws : null;
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
function statusToken(ws, leadId) {
  return createHmac("sha256", encryptionKey()).update(`call-status:${ws}:${leadId}`).digest("base64url");
}
// Twilio fetches voicemail recordings without signing in, so the address carries a signature.
function voicemailSignature(ws, id) {
  return createHmac("sha256", encryptionKey()).update(`voicemail:${ws}:${id}`).digest("base64url");
}
function audioType(bytes) {
  const head = bytes.subarray(0, 12);
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WAVE") return "audio/wav";
  if (head.subarray(0, 3).toString("latin1") === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}
// ---- Live transcription ----
// On when switched on in Settings and the lead's campaigns haven't opted out.
function transcribeFor(state, lead) {
  return features(state).transcription && !(lead.campaigns || []).some((name) => state.campaignSettings[name]?.transcribe === false);
}
function transcriptToken(ws) {
  return createHmac("sha256", encryptionKey()).update(`transcript:${ws}`).digest("base64url");
}
function transcriptUrlFor(req, ws) {
  const url = new URL("/api/twilio/voice/transcript", publicOrigin(req));
  url.searchParams.set("ws", ws);
  url.searchParams.set("sig", transcriptToken(ws));
  return url;
}
// Lines of calls in progress, by the call's sid: finished sentences plus what each side is saying right now.
// shortcut: kept in memory until the call ends, so a server restart mid-call loses that call's transcript.
const liveTranscripts = new Map();
function liveFor(sid) {
  if (!liveTranscripts.has(sid)) liveTranscripts.set(sid, { lines: [], partial: {}, stopped: false, at: Date.now() });
  return liveTranscripts.get(sid);
}
// A follow-up some business days out at 10:00, the way the app writes due dates.
function businessDaysOut(days) {
  const date = new Date();
  for (let added = 0; added < days; ) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() !== 0 && date.getDay() !== 6) added += 1;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T10:00`;
}
// A lead's value for an automation's field: detail:<column>, a lead field, or a script variable mapped in the campaign.
function automationField(field, lead, settings, campaign, depth = 0) {
  if (field.startsWith("detail:")) return String(lead.details?.[field.slice(7)] || "").trim();
  if (field === "first_name") return String(lead.name || "").replace(/^(dr|mr|mrs|ms|mx)\.?\s+/i, "").split(/\s+/)[0] || "";
  if (["name", "company", "role", "phone"].includes(field)) return String(lead[field] || "").trim();
  const source = settings[campaign]?.variables?.[field];
  if (source && depth === 0) return automationField(source, lead, settings, campaign, 1);
  const simple = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, "");
  const column = Object.keys(lead.details || {}).find((key) => simple(key) === simple(field));
  return column ? String(lead.details[column]).trim() : "";
}
function automationMatches(step, value) {
  const have = value.toLowerCase();
  const want = String(step.value || "").trim().toLowerCase();
  if (step.op === "is empty") return !have;
  if (step.op === "is not empty") return Boolean(have);
  if (step.op === "contains") return have.includes(want);
  return step.op === "is not" ? have !== want : have === want;
}
// {{variables}} in an email or text, filled from the lead like a script line.
function fillTemplate(text, lead, settings, campaign) {
  return String(text || "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name) => automationField(name.trim(), lead, settings, campaign));
}
// Twilio texts need +1XXXXXXXXXX; leads are stored as typed.
function smsNumber(phone) {
  const raw = String(phone || "").trim();
  if (raw.startsWith("+")) return `+${raw.replace(/\D/g, "")}`;
  const digits = phoneKey(raw);
  return digits.length === 10 ? `+1${digits}` : digits ? `+${digits}` : "";
}
async function sendPlainEmail(config, to, subject, text) {
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">${text.split(/\n{2,}/).map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: config.from, to: [to], subject, html, text }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`Resend: ${detail.message || response.status}`);
  }
}
const waitMs = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
// Runs one automation for a lead by following its connections from the trigger (or, after a Wait, from the nodes
// in `from`). Every connected branch runs; an If sends the lead down Yes or No; a failed Ask AI ends its branch.
// Ask AI answers become lead fields later nodes can check. A Wait saves the nodes after it as a job in
// state.scheduled, which the minute ticker picks up when it's due; other branches carry on meanwhile.
// ctx: { outcome, sid (the transcribed call), keepDue (the caller already picked a follow-up time) }.
// `from` is a list of node ids, or a step index from a job saved before the graph editor.
async function runAutomation(item, leadId, ctx, from) {
  const state = await readState();
  const lead = state.leads.find((entry) => entry.id === leadId);
  if (!lead) return;
  const campaign = item.campaigns?.length ? (lead.campaigns || []).find((name) => item.campaigns.includes(name)) : (lead.campaigns || [])[0] || "";
  if (campaign === undefined) return;
  const call = ctx.sid ? state.calls.find((entry) => entry.sid === ctx.sid) : null;
  const text = (call?.transcript || []).map((line) => `${line.who === "you" ? "You" : "Them"}: ${line.text}`).join("\n");
  const view = { ...lead, details: { ...(lead.details || {}) } };
  const details = {};
  const log = [];
  let stage = "";
  let due = "";
  const waits = [];
  const blocked = lead.dnc || state.dncNumbers.includes(phoneKey(lead.phone));
  const { nodes, edges } = flowGraph(item);
  const after = (id, port = "out") => edges.filter((edge) => edge.from === id && edge.port === port).map((edge) => edge.to);
  const queue = Array.isArray(from) ? [...from] : typeof from === "number" ? [`s${from}`] : after("trigger");
  const ran = new Set();
  while (queue.length) {
    const id = queue.shift();
    const node = nodes.find((entry) => entry.id === id);
    // Each node runs once per run, even when two branches lead into it.
    if (!node?.step || ran.has(id)) continue;
    ran.add(id);
    const step = node.step;
    if (step.type === "if") {
      queue.push(...after(id, automationMatches(step, automationField(step.field, view, state.campaignSettings, campaign)) ? "yes" : "no"));
      continue;
    }
    if (step.type === "ask") {
      const config = aiConfig(state);
      if (!config || !text || !step.prompt || !step.field) continue;
      try {
        const answer = cleanText(await aiChat(config, "You read a sales call transcript and answer one question about it. \"You\" is the caller, \"Them\" is the lead. Answer in plain words, as short as the question allows, and never invent anything the transcript doesn't say.", `Question: ${step.prompt}\n\nTranscript:\n${text}`), 500);
        details[step.field] = answer;
        view.details[step.field] = answer;
      } catch (error) {
        log.push(["Automation step failed", `${item.name} · Ask AI: ${error.message}`]);
        continue;
      }
    }
    if (step.type === "stage") stage = step.stage;
    if (step.type === "followup" && !ctx.keepDue) due = businessDaysOut(step.days);
    if (step.type === "email") {
      const config = emailConfig(state);
      const to = automationField(step.to, view, state.campaignSettings, campaign);
      if (blocked) log.push(["Automation email skipped", `${item.name} · ${leadLabel(lead)} is on Do not call`]);
      else if (!config) log.push(["Automation email skipped", `${item.name} · email isn't set up (Settings → Email)`]);
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) log.push(["Automation email skipped", `${item.name} · ${leadLabel(lead)} has no email address`]);
      else {
        try {
          await sendPlainEmail(config, to, cleanText(fillTemplate(step.subject, view, state.campaignSettings, campaign), 200), fillTemplate(step.body, view, state.campaignSettings, campaign));
          log.push(["Automation email sent", `${item.name} · ${leadLabel(lead)} · ${to}`]);
        } catch (error) {
          log.push(["Automation step failed", `${item.name} · email: ${error.message}`]);
        }
      }
    }
    if (step.type === "sms") {
      const to = smsNumber(lead.phone);
      if (blocked) log.push(["Automation text skipped", `${item.name} · ${leadLabel(lead)} is on Do not call`]);
      else if (!features(state).sms) log.push(["Automation text skipped", `${item.name} · texting is switched off (Settings → Features & costs)`]);
      else if (!state.connection?.selectedNumber || !to) log.push(["Automation text skipped", `${item.name} · no Twilio number or lead phone`]);
      else {
        try {
          await twilioRequest(state.connection, "/Messages.json", { To: to, From: state.connection.selectedNumber, Body: fillTemplate(step.text, view, state.campaignSettings, campaign).slice(0, 1600) });
          log.push(["Automation text sent", `${item.name} · ${leadLabel(lead)} · ${to}`]);
        } catch (error) {
          log.push(["Automation step failed", `${item.name} · text: ${error.message}`]);
        }
      }
    }
    if (step.type === "wait") {
      const next = after(id);
      if (next.length) {
        const wait = { id: `job_${Date.now()}_${randomBytes(3).toString("hex")}`, automationId: item.id, leadId, next, ctx: { outcome: ctx.outcome || "", sid: ctx.sid || "" }, runAt: Date.now() + Math.max(1, step.amount) * (waitMs[step.unit] || waitMs.days) };
        waits.push(wait);
        log.push(["Automation waiting", `${item.name} · ${leadLabel(lead)} · until ${new Date(wait.runAt).toLocaleString("en-US")}`]);
      }
      continue;
    }
    queue.push(...after(id));
  }
  if (!Object.keys(details).length && !stage && !due && !waits.length && !log.length) return;
  await updateState((fresh) => {
    const person = fresh.leads.find((entry) => entry.id === leadId);
    if (!person) return false;
    if (Object.keys(details).length) person.details = { ...(person.details || {}), ...details };
    if (stage && !person.dnc) enterStage(person, stage);
    if (due && !person.dnc && !["Won", "Lost"].includes(person.status)) person.due = due;
    if (waits.length) fresh.scheduled = [...(fresh.scheduled || []), ...waits];
    for (const [action, detail] of log) activity(fresh, action, detail);
    if (stage || due || Object.keys(details).length) activity(fresh, "Automation ran", `${item.name} · ${leadLabel(person)}${stage ? ` · ${stage}` : ""}`);
  });
}
// Every switched-on automation for a trigger, one after another.
async function runTrigger(trigger, leadId, ctx) {
  const state = await readState();
  for (const item of state.automations || []) {
    if (!item.on || item.trigger !== trigger || (item.outcomes?.length && !item.outcomes.includes(ctx.outcome))) continue;
    await runAutomation(item, leadId, ctx);
  }
}
// "Call transcribed": once the transcript is in and the outcome is logged. Without "Save transcripts", the text
// is dropped afterwards.
async function runTranscribed(sid) {
  const state = await readState();
  const call = state.calls.find((item) => item.sid === sid);
  if (!call || call.automated || !call.transcriptDone || !call.loggedOutcome) return;
  const marked = await updateState((fresh) => {
    const target = fresh.calls.find((item) => item.sid === sid);
    if (!target || target.automated) return false;
    target.automated = true;
    return true;
  });
  if (!marked) return;
  await runTrigger("transcribed", call.leadId, { outcome: call.loggedOutcome, sid });
  await updateState((fresh) => {
    const target = fresh.calls.find((item) => item.sid === sid);
    if (!target?.transcript || features(fresh).saveTranscripts) return false;
    delete target.transcript;
  });
}
// The minute ticker: picks up automations whose Wait is over, in every workspace.
async function runDueJobs() {
  const accounts = await readAccounts();
  for (const { id: ws } of accounts.workspaces) {
    await requestContext.run({ ws, locked: false }, async () => {
      const due = await updateState((state) => {
        const now = Date.now();
        const ready = (state.scheduled || []).filter((job) => job.runAt <= now);
        if (!ready.length) return false;
        state.scheduled = state.scheduled.filter((job) => job.runAt > now);
        return ready;
      });
      for (const job of due || []) {
        const item = ((await readState()).automations || []).find((entry) => entry.id === job.automationId);
        // Switched off or deleted while it waited: it stops here.
        if (item?.on) await runAutomation(item, job.leadId, job.ctx || {}, job.next);
      }
    }).catch((error) => console.error(`[open-dialer] Waiting automations (${ws}): ${error.message}`));
  }
}

// Runs after the response, outside the request's state lock, so its own save waits its turn like any other.
function runTranscribedLater(sid) {
  const store = requestContext.getStore();
  setImmediate(() => requestContext.run({ ...store, locked: false }, () => runTranscribed(sid)).catch((error) => console.error(`[open-dialer] ${error.message}`)));
}
function statusUrlFor(req, leadId) {
  const url = new URL("/api/twilio/voice/status", publicOrigin(req));
  url.searchParams.set("ws", currentWorkspace());
  url.searchParams.set("leadId", leadId);
  url.searchParams.set("token", statusToken(currentWorkspace(), leadId));
  return url;
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
function sessionSignature(payload) {
  return createHmac("sha256", encryptionKey()).update(`open-dialer-session:${payload}`).digest("base64url");
}
async function sessionUser(req) {
  const [userId, expiresAt, version, signature] = String(cookies(req).open_dialer_session || "").split(".");
  if (!userId || !/^\d{13}$/.test(expiresAt || "") || Number(expiresAt) <= Date.now() || !signature) return null;
  if (!safeEqual(signature, sessionSignature(`${userId}.${expiresAt}.${version}`))) return null;
  const user = (await readAccounts()).users.find((item) => item.id === userId);
  return user && String(user.sessionVersion || 0) === version ? user : null;
}
function cookieAttributes(maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}
function setSession(res, user, remember = false) {
  const lifetime = remember ? rememberedSessionLifetimeMs : sessionLifetimeMs;
  const payload = `${user.id}.${Date.now() + lifetime}.${user.sessionVersion || 0}`;
  res.setHeader("set-cookie", `open_dialer_session=${payload}.${sessionSignature(payload)}; ${cookieAttributes(lifetime / 1000)}`);
}
function clearSession(res) {
  res.setHeader("set-cookie", [`open_dialer_session=; ${cookieAttributes(0)}`, `open_dialer_remember=; ${cookieAttributes(0)}`]);
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
    const store = { ws: null, user: null };
    if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/twilio/voice/")) {
      store.user = await sessionUser(req);
      store.ws = store.user?.workspace || null;
    }
    // Every request that changes something waits its turn, so two users can't overwrite each other.
    // AI requests wait seconds on the provider, so they save through updateState instead of holding everyone's turn.
    const changes = url.pathname.startsWith("/api/") && req.method !== "GET" && !url.pathname.startsWith("/api/twilio/voice/") && !url.pathname.startsWith("/api/ai/");
    await requestContext.run(store, () => (changes ? exclusive(() => route(req, res, url)) : route(req, res, url)));
  } catch (error) {
    json(res, 400, {
      error:
        error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
}).listen(port, "0.0.0.0", () => console.log(`Open Dialer v2 listening on ${port}`));
// Automations that are waiting (a Wait step) carry on once a minute when they're due.
setInterval(() => void runDueJobs().catch((error) => console.error(`[open-dialer] ${error.message}`)), 60_000);

async function route(req, res, url) {
    if (url.pathname === "/api/twilio/voice/connect" && req.method === "GET") {
      const leadId = url.searchParams.get("leadId");
      const ws = voiceTokenWorkspace(url.searchParams.get("token"), leadId);
      if (!ws) return twiml(res, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Hangup/></Response>");
      requestContext.getStore().ws = ws;
      const state = await readState();
      const lead = state.leads.find((item) => item.id === leadId);
      if (!lead || lead.dnc)
        return twiml(res, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Hangup/></Response>");
      return twiml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${escapeXml(state.connection?.selectedNumber || "")}"><Number${lead.extension ? ` sendDigits="wwww${extensionDigits(lead.extension)}"` : ""}>${escapeXml(lead.phone)}</Number></Dial></Response>`);
    }
    if (url.pathname === "/api/twilio/voice/voicemail" && req.method === "GET") {
      const ws = url.searchParams.get("ws") || "";
      const id = url.searchParams.get("id") || "";
      if (!ws || !/^vm_\w+$/.test(id) || !safeEqual(url.searchParams.get("sig") || "", voicemailSignature(ws, id))) return json(res, 403, { error: "Invalid voicemail link." });
      requestContext.getStore().ws = ws;
      const file = await readBlob(scopedBlob(`voicemail-file:${id}`));
      if (!file) return json(res, 404, { error: "No recording." });
      res.writeHead(200, { "content-type": file.type || "audio/wav", "cache-control": "no-store" });
      return res.end(Buffer.from(file.data, "base64"));
    }
    if (url.pathname === "/api/twilio/voice/status" && req.method === "POST") {
      const leadId = url.searchParams.get("leadId") || "";
      const token = url.searchParams.get("token") || "";
      const ws = url.searchParams.get("ws") || "";
      if (!leadId || !ws || !safeEqual(token, statusToken(ws, leadId))) return json(res, 403, { error: "Invalid status token." });
      requestContext.getStore().ws = ws;
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
        // Talk time of the lead's leg, for the cost estimate in Settings.
        if (report.ParentCallSid && report.CallDuration) call.seconds = Math.max(0, Number(report.CallDuration) || 0);
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
    // Twilio's live transcription: one POST per finished or in-progress sentence, then one when it stops.
    if (url.pathname === "/api/twilio/voice/transcript" && req.method === "POST") {
      const ws = url.searchParams.get("ws") || "";
      if (!ws || !safeEqual(url.searchParams.get("sig") || "", transcriptToken(ws))) return json(res, 403, { error: "Invalid transcript link." });
      requestContext.getStore().ws = ws;
      const report = await getFormBody(req);
      const sid = String(report.CallSid || "");
      if (!sid) return json(res, 200, {});
      const live = liveFor(sid);
      const event = String(report.TranscriptionEvent || "");
      if (event === "transcription-content") {
        let said = "";
        try { said = String(JSON.parse(report.TranscriptionData || "{}").transcript || "").trim(); } catch {}
        // The browser's side is the inbound track; the lead is what Twilio plays back to it.
        const who = report.Track === "inbound_track" ? "you" : "lead";
        if (report.Final === "true") {
          delete live.partial[who];
          if (said) live.lines.push({ who, text: said.slice(0, 2000), at: new Date().toISOString() });
        } else live.partial[who] = said;
      }
      if (event === "transcription-error") console.error(`[open-dialer] Transcription error ${report.TranscriptionErrorCode}: ${report.TranscriptionError}`);
      if (event === "transcription-stopped" || event === "transcription-error") {
        live.stopped = true;
        live.partial = {};
        const run = await updateState((state) => {
          const call = state.calls.find((item) => item.sid === sid);
          if (!call || call.transcriptDone) return false;
          call.transcript = live.lines.slice(0, 2000);
          call.transcriptDone = true;
          if (event === "transcription-error") call.transcriptError = cleanText(report.TranscriptionError, 200);
          return call.loggedOutcome ? "run" : "saved";
        });
        // Kept a minute so a last poll from the call screen still sees it.
        setTimeout(() => liveTranscripts.delete(sid), 60_000);
        if (run === "run") runTranscribedLater(sid);
      }
      return json(res, 200, {});
    }
    if (url.pathname.startsWith("/api/calls/") && url.pathname.endsWith("/transcript") && req.method === "GET") {
      const id = url.pathname.split("/")[3];
      const state = await readState();
      const call = state.calls.find((item) => item.id === id);
      if (!call || !findLead(state, call.leadId)) return json(res, 404, { error: "Call not found." });
      const live = call.sid && liveTranscripts.get(call.sid);
      return json(res, 200, { on: Boolean(call.transcribing), stopped: Boolean(live?.stopped || call.transcriptDone), lines: live ? live.lines : call.transcript || [], partial: live?.partial || {} });
    }
    // The caller turns transcription off for the rest of this call, e.g. when the lead asks.
    if (url.pathname === "/api/calls/transcript/stop" && req.method === "POST") {
      const { callId } = await getBody(req);
      const state = await readState();
      const call = state.calls.find((item) => item.id === callId);
      if (!call?.sid || !findLead(state, call.leadId)) return json(res, 404, { error: "That call isn't running anymore." });
      try {
        await twilioRequest(state.connection, `/Calls/${call.sid}/Transcriptions/notes.json`, { Status: "stopped" });
      } catch (error) {
        return json(res, 502, { error: error.message });
      }
      liveFor(call.sid).stopped = true;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/twilio/voice/client" && req.method === "POST") {
      const params = await getFormBody(req);
      const hangup = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
      const ws = voiceTokenWorkspace(params.token, params.leadId);
      if (!ws) return twiml(res, hangup);
      requestContext.getStore().ws = ws;
      const state = await readState();
      const lead = state.leads.find((item) => item.id === params.leadId);
      if (!lead || lead.dnc) return twiml(res, hangup);
      const transcribe = transcribeFor(state, lead);
      await updateState((fresh) => {
        if (fresh.calls.some((item) => item.sid === params.CallSid)) return false;
        fresh.calls.unshift({ id: /^call_[\w]+$/.test(params.callId || "") ? params.callId : `call_${Date.now()}`, leadId: lead.id, outcome: "In progress", note: "Calling from the app.", at: new Date().toISOString(), sid: params.CallSid, ...(/^user_\w+$/.test(params.userId || "") ? { userId: params.userId } : {}), ...(transcribe ? { transcribing: true } : {}) });
        activity(fresh, "Call started", `${leadLabel(lead)} · from the app`);
      });
      const statusUrl = statusUrlFor(req, lead.id);
      const digits = lead.extension ? ` sendDigits="wwww${extensionDigits(lead.extension)}"` : "";
      // Live transcription (Settings → Features & costs): Twilio sends each sentence to /transcript. Nothing is recorded.
      const start = transcribe ? `<Start><Transcription name="notes" statusCallbackUrl="${escapeXml(transcriptUrlFor(req, ws).toString())}" track="both_tracks" inboundTrackLabel="you" outboundTrackLabel="lead" partialResults="true" /></Start>` : "";
      return twiml(res, `<?xml version="1.0" encoding="UTF-8"?><Response>${start}<Dial callerId="${escapeXml(state.connection?.selectedNumber || "")}" answerOnBridge="true"><Number${digits} statusCallback="${escapeXml(statusUrl.toString())}" statusCallbackMethod="POST" statusCallbackEvent="initiated ringing answered completed">${escapeXml(lead.phone)}</Number></Dial></Response>`);
    }
    if (url.pathname === "/api/session" && req.method === "GET") {
      const user = currentUser();
      // A fresh install has no accounts yet: the sign-in page offers to create the owner instead.
      return json(res, 200, { authenticated: Boolean(user), firstRun: !user && (await readAccounts()).users.length === 0 });
    }
    // First run only: the person installing Open Dialer creates its owner (and app admin) account and company.
    if (url.pathname === "/api/setup" && req.method === "POST") {
      const body = await getBody(req);
      const name = cleanText(body.name, 120);
      const email = cleanEmail(body.email);
      const company = cleanText(body.company, 160) || "My company";
      if (!name || !email) return json(res, 400, { error: "Enter your name and a valid email." });
      if (!validPassword(body.password)) return json(res, 400, { error: "Use a password of at least 10 characters." });
      const user = await updateAccounts((accounts) => {
        if (accounts.users.length) return false;
        if (!accounts.workspaces.some((item) => item.id === legacyWorkspace)) accounts.workspaces.push({ id: legacyWorkspace, name: company, createdAt: new Date().toISOString() });
        const owner = { id: `user_${randomBytes(8).toString("hex")}`, email, name, role: "owner", admin: true, workspace: legacyWorkspace, passwordHash: hashPassword(body.password), sessionVersion: 0, createdAt: new Date().toISOString() };
        accounts.users.push(owner);
        return owner;
      });
      if (!user) return json(res, 409, { error: "Open Dialer is already set up. Sign in instead." });
      setSession(res, user, true);
      return json(res, 204, {});
    }
    if (url.pathname === "/api/session" && req.method === "POST") {
      if (!canAttemptLogin(req)) return json(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
      const body = await getBody(req);
      const user = (await readAccounts()).users.find((item) => item.email === cleanEmail(body.email));
      if (!user || !checkPassword(body.password, user.passwordHash)) {
        recordFailedLogin(req);
        return json(res, 401, { error: "That email and password don't match an account." });
      }
      clearFailedLogins(req);
      setSession(res, user, body.remember === true);
      return json(res, 204, {});
    }
    // Accounts are invite-only. Forgot password emails a reset link; the answer never says whether the email exists.
    if (url.pathname === "/api/password/forgot" && req.method === "POST") {
      if (!canAttemptLogin(req)) return json(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
      recordFailedLogin(req);
      const email = cleanEmail((await getBody(req)).email);
      const owner = (await readAccounts()).users.find((item) => item.email === email && item.passwordHash);
      if (owner) requestContext.getStore().ws = owner.workspace;
      if (owner && !emailReady(await readState())) return json(res, 503, { error: "Email isn't set up yet. Ask your company's owner for a new sign-in link." });
      const found = owner && await updateAccounts((accounts) => {
        const user = accounts.users.find((item) => item.email === email && item.passwordHash);
        return user ? { user: { ...user }, token: giveLink(user, "reset") } : false;
      });
      if (found) await sendReset(req, found.user, found.token).catch((error) => console.error(`[open-dialer] reset email failed: ${error.message}`));
      return json(res, 200, { message: "If that email has an account, a reset link is on its way." });
    }
    // The page behind an invite or reset link: who it's for, then setting the password.
    if (url.pathname === "/api/welcome" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await getBody(req) : {};
      const token = req.method === "GET" ? url.searchParams.get("token") : body.token;
      if (req.method === "GET") {
        const accounts = await readAccounts();
        const user = userForLink(accounts, token);
        if (!user) return json(res, 404, { error: "This link has expired or was already used. Ask for a new one." });
        return json(res, 200, { name: user.name, email: user.email, kind: user.link.kind, company: accounts.workspaces.find((item) => item.id === user.workspace)?.name || "" });
      }
      if (!validPassword(body.password)) return json(res, 400, { error: "Use a password of at least 10 characters." });
      const user = await updateAccounts((accounts) => {
        const found = userForLink(accounts, token);
        if (!found) return false;
        found.passwordHash = hashPassword(body.password);
        found.sessionVersion = (found.sessionVersion || 0) + 1;
        delete found.link;
        return found;
      });
      if (!user) return json(res, 404, { error: "This link has expired or was already used. Ask for a new one." });
      setSession(res, user, true);
      return json(res, 204, {});
    }
    if (url.pathname === "/api/session" && req.method === "DELETE") {
      clearSession(res);
      return json(res, 204, {});
    }
    if (url.pathname.startsWith("/api/") && !currentUser())
      return json(res, 401, { error: "Sign in to access this workspace." });
    // Things only a company's owner can change: calling setup, the team, imports, deleting and scripts.
    const ownerOnly = [
      ["POST", /^\/api\/twilio\/(validate|connection)$/], ["DELETE", /^\/api\/twilio\/connection$/], ["PATCH", /^\/api\/twilio\/connection$/], ["GET", /^\/api\/twilio\/account-check$/],
      ["PATCH", /^\/api\/settings$/], ["PUT", /^\/api\/settings\/fields$/], ["POST", /^\/api\/leads\/(import|delete|assign)$/], ["DELETE", /^\/api\/leads\/[^/]+$/], ["DELETE", /^\/api\/dnc\/[^/]+$/], ["POST", /^\/api\/dnc$/],
      ["PUT", /^\/api\/campaigns\/script$/], ["POST", /^\/api\/campaigns\/script-pdf$/], ["DELETE", /^\/api\/campaigns\/script-pdf$/], ["PUT", /^\/api\/automations$/], ["PATCH", /^\/api\/settings\/features$/], ["PUT", /^\/api\/email\/settings$/], ["DELETE", /^\/api\/email\/settings$/], ["POST", /^\/api\/email\/test$/], ["POST", /^\/api\/voicemails$/], ["PATCH", /^\/api\/voicemails\/[^/]+$/], ["DELETE", /^\/api\/voicemails\/[^/]+$/],
      ["POST", /^\/api\/team$/], ["PATCH", /^\/api\/team\/[^/]+$/], ["DELETE", /^\/api\/team\/[^/]+$/], ["PATCH", /^\/api\/workspace$/],
      ["PUT", /^\/api\/ai\/settings$/], ["DELETE", /^\/api\/ai\/settings$/], ["POST", /^\/api\/ai\/(preview|forget)$/],
    ];
    if (!isOwner() && ownerOnly.some(([method, path]) => method === req.method && path.test(url.pathname)))
      return json(res, 403, { error: "Only your company's owner can do that." });
    // App admins (set on the account record) bring on new companies: a workspace plus an invited owner.
    if (url.pathname === "/api/companies" && req.method === "POST") {
      if (!currentUser().admin) return json(res, 403, { error: "Only an Open Dialer admin can add companies." });
      const body = await getBody(req);
      const company = cleanText(body.company, 160);
      const name = cleanText(body.name, 120);
      const email = cleanEmail(body.email);
      if (!company || !name || !email) return json(res, 400, { error: "Enter the company, the owner's name and a valid email." });
      const created = await updateAccounts((accounts) => {
        if (accounts.users.some((item) => item.email === email)) return false;
        const ws = `ws_${randomBytes(8).toString("hex")}`;
        accounts.workspaces.push({ id: ws, name: company, createdAt: new Date().toISOString() });
        const user = { id: `user_${randomBytes(8).toString("hex")}`, email, name, role: "owner", workspace: ws, sessionVersion: 0, createdAt: new Date().toISOString() };
        const token = giveLink(user, "invite");
        accounts.users.push(user);
        return { user: { ...user }, token };
      });
      if (!created) return json(res, 409, { error: "That email already has an Open Dialer account." });
      return json(res, 201, { user: publicUser(created.user), ...(await sendInvite(req, created.user, created.token, currentUser().name, company)) });
    }
    if (url.pathname === "/api/account" && req.method === "PATCH") {
      const { name, currentPassword, newPassword: next } = await getBody(req);
      const me = currentUser();
      if (next !== undefined) {
        if (!checkPassword(currentPassword, me.passwordHash)) return json(res, 400, { error: "Your current password isn't right." });
        if (!validPassword(next)) return json(res, 400, { error: "Use a new password of at least 10 characters." });
      }
      const updated = await updateAccounts((accounts) => {
        const user = accounts.users.find((item) => item.id === me.id);
        if (typeof name === "string" && cleanText(name, 120)) user.name = cleanText(name, 120);
        if (next !== undefined) {
          user.passwordHash = hashPassword(next);
          user.sessionVersion = (user.sessionVersion || 0) + 1;
        }
        return user;
      });
      // A new password signs out every other browser; keep this one signed in.
      if (next !== undefined) setSession(res, updated, true);
      return json(res, 200, publicUser(updated));
    }
    if (url.pathname === "/api/workspace" && req.method === "PATCH") {
      const name = cleanText((await getBody(req)).name, 160);
      if (!name) return json(res, 400, { error: "Enter your company's name." });
      await updateAccounts((accounts) => { accounts.workspaces.find((item) => item.id === currentWorkspace()).name = name; });
      return json(res, 200, { name });
    }
    if (url.pathname === "/api/team" && req.method === "POST") {
      const body = await getBody(req);
      const email = cleanEmail(body.email);
      const name = cleanText(body.name, 120);
      if (!name || !email) return json(res, 400, { error: "Enter their name and a valid email address." });
      const created = await updateAccounts((accounts) => {
        if (accounts.users.some((item) => item.email === email)) return false;
        const user = { id: `user_${randomBytes(8).toString("hex")}`, email, name, role: body.role === "owner" ? "owner" : "caller", workspace: currentWorkspace(), sessionVersion: 0, createdAt: new Date().toISOString() };
        const token = giveLink(user, "invite");
        accounts.users.push(user);
        return { user: { ...user }, token, company: accounts.workspaces.find((item) => item.id === currentWorkspace())?.name || "your team" };
      });
      if (!created) return json(res, 409, { error: "That email already has an Open Dialer account." });
      return json(res, 201, { user: publicUser(created.user), ...(await sendInvite(req, created.user, created.token, currentUser().name, created.company)) });
    }
    if (url.pathname.match(/^\/api\/team\/[^/]+$/) && (req.method === "PATCH" || req.method === "DELETE")) {
      const id = url.pathname.split("/").pop();
      if (id === currentUser().id) return json(res, 400, { error: "Change your own account under Profile." });
      const body = req.method === "PATCH" ? await getBody(req) : {};
      // sendLink: a fresh invite (not signed in yet) or a password reset link, by email when it's set up.
      let token = null;
      let company = "";
      const result = await updateAccounts((accounts) => {
        const user = accounts.users.find((item) => item.id === id && item.workspace === currentWorkspace());
        if (!user) return false;
        if (req.method === "DELETE") accounts.users = accounts.users.filter((item) => item !== user);
        if (body.role === "owner" || body.role === "caller") user.role = body.role;
        if (body.sendLink === true) token = giveLink(user, user.passwordHash ? "reset" : "invite");
        company = accounts.workspaces.find((item) => item.id === currentWorkspace())?.name || "your team";
        return { ...user };
      });
      if (!result) return json(res, 404, { error: "That person isn't on your team." });
      if (req.method === "DELETE")
        // Their leads go back to the owner's unassigned pile.
        await updateState((state) => { for (const lead of state.leads) if (lead.assignedTo === id) delete lead.assignedTo; });
      const sent = token ? await (result.passwordHash ? sendReset(req, result, token) : sendInvite(req, result, token, currentUser().name, company)) : {};
      return json(res, 200, { user: publicUser(result), ...sent });
    }
    if (url.pathname === "/api/leads/assign" && req.method === "POST") {
      const { ids, userId } = await getBody(req);
      if (!Array.isArray(ids) || !ids.length) return json(res, 400, { error: "Select at least one lead." });
      const accounts = await readAccounts();
      const assignee = userId ? accounts.users.find((item) => item.id === userId && item.workspace === currentWorkspace()) : null;
      if (userId && !assignee) return json(res, 400, { error: "That person isn't on your team." });
      const wanted = new Set(ids);
      let changed = 0;
      await updateState((state) => {
        for (const lead of state.leads) {
          if (!wanted.has(lead.id)) continue;
          if (assignee) lead.assignedTo = assignee.id;
          else delete lead.assignedTo;
          changed += 1;
        }
        activity(state, "Leads assigned", `${changed} lead${changed === 1 ? "" : "s"} ${assignee ? `assigned to ${assignee.name}` : "unassigned"}`);
      });
      return json(res, 200, { assigned: changed });
    }
    if (url.pathname === "/api/state" && req.method === "GET") {
      const accounts = await readAccounts();
      const me = currentUser();
      const state = await readState();
      // callbackReachable tells the setup guide whether Twilio could fetch the call instructions from this app.
      return json(res, 200, {
        ...safeState(visibleState(state)),
        callbackReachable: !/\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(publicOrigin(req)),
        me: publicUser(me),
        workspace: { id: me.workspace, name: accounts.workspaces.find((item) => item.id === me.workspace)?.name || "Workspace" },
        team: accounts.users.filter((item) => item.workspace === me.workspace).map((item) => publicUser(item, isOwner())),
        emailReady: emailReady(state),
        ...(me.admin ? { companies: accounts.workspaces.map((ws) => ({ id: ws.id, name: ws.name, people: accounts.users.filter((item) => item.workspace === ws.id).map((item) => publicUser(item)) })) } : {}),
      });
    }
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
        ...(isOwner() ? {} : { assignedTo: currentUser().id }),
        dnc: false,
        note: "Added manually.",
        due: "Unscheduled",
      };
      applyDetails(lead, body.details);
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
      const { campaign, script, variables, value, clean, pinned, transcribe, scriptId, scriptName, activate, remove } = await getBody(req);
      const name = campaignName(campaign);
      if (!name) return json(res, 400, { error: "Choose a campaign." });
      // What one won deal in this campaign is worth; blank clears it.
      const amount = value === undefined ? undefined : value === null || value === "" ? null : Number(value);
      if (amount !== undefined && amount !== null && (!Number.isFinite(amount) || amount < 0)) return json(res, 400, { error: "Deal value must be a positive number." });
      const state = await readState();
      const current = state.campaignSettings[name] || {};
      // A new campaign can start with its script; its leads are imported after.
      const text = typeof script === "string" ? script.replace(/\r\n/g, "\n").trim().slice(0, 20000) : current.script || "";
      // Which lead field or CSV column fills each {{variable}} in the script, e.g. { fact: "detail:Short fact" }.
      const map = variables && typeof variables === "object" && !Array.isArray(variables)
        ? Object.fromEntries(Object.entries(variables).slice(0, 60).map(([key, value]) => [cleanText(key, 60), cleanText(value, 120)]).filter(([key, value]) => key && value))
        : current.variables || {};
      // A campaign keeps several named scripts; the one picked on the Scripts page is "in use" and is mirrored into
      // `script`, which the call screen, variables and AI cleanup read. Campaigns saved before this get one "Script 1".
      const scripts = Array.isArray(current.scripts) && current.scripts.length
        ? current.scripts.map((item) => ({ ...item }))
        : current.script ? [{ id: "s1", name: "Script 1", script: current.script }] : [];
      let inUse = scripts.some((item) => item.id === current.activeScript) ? current.activeScript : scripts[0]?.id;
      let target = scripts.find((item) => item.id === (scriptId || inUse));
      if (typeof script === "string") {
        if (!target) {
          target = { id: `s${Date.now().toString(36)}`, name: `Script ${scripts.length + 1}`, script: "" };
          scripts.push(target);
        }
        target.script = text;
      }
      if (target && typeof scriptName === "string" && cleanText(scriptName, 60)) target.name = cleanText(scriptName, 60);
      if (typeof remove === "string") {
        const index = scripts.findIndex((item) => item.id === remove);
        if (index >= 0) scripts.splice(index, 1);
      }
      if (typeof activate === "string" && scripts.some((item) => item.id === activate)) inUse = activate;
      if (!scripts.some((item) => item.id === inUse)) inUse = scripts[0]?.id;
      state.campaignSettings[name] = { ...current, scripts, activeScript: inUse, script: scripts.find((item) => item.id === inUse)?.script || "", variables: map };
      if (!scripts.length) delete state.campaignSettings[name].activeScript;
      if (amount === null) delete state.campaignSettings[name].value;
      else if (amount !== undefined) state.campaignSettings[name].value = amount;
      // Lead details shown first on the call screen for this campaign, in the order they were pinned.
      if (typeof transcribe === "boolean") state.campaignSettings[name].transcribe = transcribe;
      if (Array.isArray(pinned)) state.campaignSettings[name].pinned = [...new Set(pinned.map((label) => cleanText(label, 60)).filter(Boolean))].slice(0, 6);
      // AI cleanup per variable: an example (raw → how you'd say it) and notes. Turning one off drops its saved versions.
      if (clean && typeof clean === "object" && !Array.isArray(clean)) {
        const rules = Object.fromEntries(Object.entries(clean).slice(0, 60)
          .map(([key, rule]) => [cleanText(key, 60), { from: cleanText(rule?.from, 1000), to: cleanText(rule?.to, 500), notes: cleanText(rule?.notes, 500) }])
          .filter(([key, rule]) => key && (rule.to || rule.notes)));
        for (const variable of Object.keys(current.clean || {})) if (!rules[variable]) forgetSpoken(state, name, variable);
        state.campaignSettings[name].clean = rules;
      }
      activity(state, typeof activate === "string" ? "Script in use changed" : typeof remove === "string" ? "Script deleted" : Array.isArray(pinned) && typeof script !== "string" ? "Pinned details updated" : typeof script !== "string" ? "Script variables saved" : "Campaign settings saved", name);
      await writeState(state);
      return json(res, 200, state.campaignSettings[name]);
    }
    if (url.pathname === "/api/automations" && req.method === "PUT") {
      const { automations } = await getBody(req);
      if (!Array.isArray(automations)) return json(res, 400, { error: "Send the automations list." });
      const saved = await updateState((state) => {
        state.automations = cleanAutomations(automations);
        activity(state, "Automations saved", `${state.automations.length}`);
        return state.automations;
      });
      return json(res, 200, saved);
    }
    // The voicemail vault: add (record or upload), rename, delete, and listen.
    if (url.pathname === "/api/voicemails" && req.method === "POST") {
      const body = await getBody(req);
      const bytes = typeof body.data === "string" ? Buffer.from(body.data, "base64") : Buffer.alloc(0);
      const type = audioType(bytes);
      if (!type) return json(res, 400, { error: "Use an MP3 or WAV file, or record one here." });
      const item = { id: `vm_${Date.now()}_${randomBytes(3).toString("hex")}`, name: cleanText(body.name, 80) || "Voicemail", size: bytes.length, seconds: Math.max(0, Math.round(Number(body.seconds) || 0)), createdAt: new Date().toISOString(), ...voicemailLabels(body) };
      await writeBlob(scopedBlob(`voicemail-file:${item.id}`), { type, data: bytes.toString("base64") });
      await updateState((state) => {
        state.voicemails.unshift(item);
        activity(state, "Voicemail recording saved", item.name);
      });
      return json(res, 201, item);
    }
    const vaultMatch = url.pathname.match(/^\/api\/voicemails\/(vm_\w+)(\/audio)?$/);
    if (vaultMatch) {
      const id = vaultMatch[1];
      if (vaultMatch[2] && req.method === "GET") {
        const file = await readBlob(scopedBlob(`voicemail-file:${id}`));
        if (!file) return json(res, 404, { error: "No recording." });
        res.writeHead(200, { "content-type": file.type || "audio/wav", "cache-control": "no-store" });
        return res.end(Buffer.from(file.data, "base64"));
      }
      if (!vaultMatch[2] && req.method === "PATCH") {
        const body = await getBody(req);
        const label = body.name === undefined ? undefined : cleanText(body.name, 80);
        if (label === "") return json(res, 400, { error: "Give it a name." });
        const found = await updateState((state) => {
          const item = state.voicemails.find((entry) => entry.id === id);
          if (!item) return false;
          if (label) item.name = label;
          Object.assign(item, voicemailLabels(body));
          return true;
        });
        return found ? json(res, 200, { ok: true }) : json(res, 404, { error: "That recording is gone." });
      }
      if (!vaultMatch[2] && req.method === "DELETE") {
        await writeBlob(scopedBlob(`voicemail-file:${id}`), null);
        await updateState((state) => {
          const item = state.voicemails.find((entry) => entry.id === id);
          state.voicemails = state.voicemails.filter((entry) => entry.id !== id);
          activity(state, "Voicemail recording deleted", item?.name || "");
        });
        return json(res, 200, { ok: true });
      }
    }
    // During a call: play the campaign's recording to the lead (their voicemail) and hang up their side.
    if (url.pathname === "/api/calls/drop-voicemail" && req.method === "POST") {
      const { callId, campaign, recordingId } = await getBody(req);
      const state = await readState();
      const call = state.calls.find((item) => item.id === callId);
      if (!call || !findLead(state, call.leadId)) return json(res, 404, { error: "That call isn't running anymore." });
      if (!call.leadLegSid) return json(res, 409, { error: "The lead's side hasn't picked up yet. Wait for the beep, then drop it." });
      const name = campaignName(campaign);
      const played = (state.automations || []).some((item) => item.on && item.trigger === "voicemail" && (!item.campaigns?.length || item.campaigns.includes(name)) && flowGraph(item).nodes.some(({ step }) => step && step.type === "play" && step.recordingId === recordingId));
      const recording = played && state.voicemails.find((entry) => entry.id === recordingId);
      if (!recording) return json(res, 400, { error: "This campaign has no voicemail for this lead. Add a Voicemail dropped automation in Automations." });
      const audio = new URL("/api/twilio/voice/voicemail", publicOrigin(req));
      audio.searchParams.set("ws", currentWorkspace());
      audio.searchParams.set("id", recording.id);
      audio.searchParams.set("sig", voicemailSignature(currentWorkspace(), recording.id));
      try {
        await twilioRequest(state.connection, `/Calls/${call.leadLegSid}.json`, { Twiml: `<Response><Play>${escapeXml(audio.toString())}</Play><Hangup/></Response>` });
      } catch (error) {
        return json(res, 502, { error: error.message });
      }
      return json(res, 200, { name: recording.name });
    }
    if (url.pathname === "/api/campaigns/script-pdf") {
      const name = campaignName(req.method === "GET" || req.method === "DELETE" ? url.searchParams.get("campaign") : "");
      const blobId = (campaign) => scopedBlob(`script-pdf:${campaign}`);
      if (req.method === "GET") {
        const file = name && (isOwner() || (await readState()).leads.some((lead) => canSee(lead) && lead.campaigns.includes(name))) && (await readBlob(blobId(name)));
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
      if (leadId && !findLead(state, leadId)) return json(res, 400, { error: "That lead no longer exists." });
      const task = { id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, title: text, details: cleanText(details, 4000), due: cleanText(due, 40), leadId: leadId || null, userId: currentUser().id, createdAt: new Date().toISOString(), doneAt: null };
      state.tasks.unshift(task);
      activity(state, "Task added", text);
      await writeState(state);
      return json(res, 201, task);
    }
    if (url.pathname.match(/^\/api\/tasks\/[^/]+$/) && (req.method === "PATCH" || req.method === "DELETE")) {
      const id = url.pathname.split("/")[3];
      const state = await readState();
      const task = state.tasks.find((item) => item.id === id && (isOwner() || item.userId === currentUser().id));
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
          if (leadId && !findLead(state, leadId)) return json(res, 400, { error: "That lead no longer exists." });
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
        if (wanted.has(lead.id) && canSee(lead) && !lead.campaigns.includes(tag)) { lead.campaigns.push(tag); added += 1; }
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
      const lead = findLead(state, url.pathname.split("/").pop());
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
      applyDetails(lead, body.details);
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
      const lead = findLead(state, url.pathname.split("/")[3]);
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
      const lead = findLead(state, leadId);
      if (!lead) return json(res, 404, { error: "Lead not found." });
      if (!callOutcomes.includes(outcome)) return json(res, 400, { error: "Choose a valid call outcome." });
      const call = { id: `call_${Date.now()}`, leadId: lead.id, outcome, note: String(note || "").trim().slice(0, 1000), at: new Date().toISOString(), userId: currentUser().id };
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
      // The newest transcribed call of this lead waits for its outcome before "Call transcribed" automations run.
      const heard = state.calls.find((item) => item.sid && item.leadId === lead.id && item.transcribing && !item.loggedOutcome);
      if (heard) heard.loggedOutcome = outcome;
      await writeState(state);
      // "Call outcome logged" automations: stage and follow-up steps land before the page refreshes.
      if (outcome !== "Do not call") await runTrigger("outcome", lead.id, { outcome, keepDue: Boolean(followUp) }).catch((error) => console.error(`[open-dialer] ${error.message}`));
      if (heard?.transcriptDone) runTranscribedLater(heard.sid);
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
      if (!call || !findLead(state, call.leadId)) return json(res, 404, { error: "Call not found." });
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
    if (url.pathname === "/api/ai/settings" && req.method === "PUT") {
      const body = await getBody(req);
      const provider = aiProviders[body.provider] ? body.provider : "";
      if (!provider) return json(res, 400, { error: "Choose Groq or OpenRouter." });
      const model = cleanText(body.model, 120) || aiProviders[provider].model;
      const typed = cleanText(body.key, 400);
      const saved = await readState();
      if (!typed && !saved.ai?.key) return json(res, 400, { error: "Paste your API key." });
      const key = typed || unseal(saved.ai.key);
      // One tiny request, so a wrong key or model name shows up now instead of mid-call.
      try {
        await aiChat({ provider, model, key }, "Reply with the single word OK.", "Say OK.");
      } catch (error) {
        return json(res, 400, { error: `That didn't work. ${error.message}` });
      }
      await updateState((state) => {
        state.ai = { provider, model, key: typed ? seal(typed) : state.ai.key, hint: typed ? `${typed.slice(0, 4)}…${typed.slice(-4)}` : state.ai.hint };
        activity(state, "AI key saved", `${aiProviders[provider].name} · ${model}`);
      });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/ai/settings" && req.method === "DELETE") {
      await updateState((state) => {
        delete state.ai;
        activity(state, "AI key removed", "");
      });
      return json(res, 200, { ok: true });
    }
    // Try a variable's example and notes on a few real values without saving anything.
    if (url.pathname === "/api/ai/preview" && req.method === "POST") {
      const body = await getBody(req);
      const config = aiConfig(await readState());
      if (!config) return json(res, 400, { error: "Add an AI key in Settings, AI first." });
      const variable = cleanText(body.variable, 60);
      const rule = { from: cleanText(body.rule?.from, 1000), to: cleanText(body.rule?.to, 500), notes: cleanText(body.rule?.notes, 500) };
      const texts = (Array.isArray(body.texts) ? body.texts : []).map((text) => cleanText(text, 1000)).filter(Boolean).slice(0, 5);
      if (!variable || !texts.length) return json(res, 400, { error: "No lead has a value for this variable yet." });
      try {
        return json(res, 200, { results: await aiClean(config, { [variable]: rule }, texts.map((text) => ({ variable, text }))) });
      } catch (error) {
        return json(res, 502, { error: error.message });
      }
    }
    // Clean the variables of the lead on screen and the next few. Values already cleaned stay unless force is set.
    if (url.pathname === "/api/ai/clean" && req.method === "POST") {
      const body = await getBody(req);
      const state = await readState();
      const config = aiConfig(state);
      if (!config) return json(res, 400, { error: "Add an AI key in Settings, AI first." });
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 25).map((item) => ({ leadId: String(item?.leadId || ""), campaign: campaignName(item?.campaign), variable: cleanText(item?.variable, 60), text: cleanText(item?.text, 1000) })).filter((item) => {
        const lead = findLead(state, item.leadId);
        return lead && item.text && lead.campaigns?.includes(item.campaign) && state.campaignSettings[item.campaign]?.clean?.[item.variable]
          && (body.force || lead.spoken?.[item.variable]?.from !== item.text);
      });
      if (!items.length) return json(res, 200, { cleaned: 0 });
      const rules = Object.fromEntries(items.map((item) => [item.variable, state.campaignSettings[item.campaign].clean[item.variable]]));
      let results;
      try {
        results = await aiClean(config, rules, items);
      } catch (error) {
        return json(res, 502, { error: error.message });
      }
      await updateState((fresh) => {
        items.forEach((item, index) => {
          const lead = findLead(fresh, item.leadId);
          if (lead && results[index]) lead.spoken = { ...(lead.spoken || {}), [item.variable]: { from: item.text, text: results[index] } };
        });
      });
      return json(res, 200, { cleaned: items.length });
    }
    // Regenerate for every lead: drop the saved versions, so each is cleaned again when it comes up.
    if (url.pathname === "/api/ai/forget" && req.method === "POST") {
      const body = await getBody(req);
      const campaign = campaignName(body.campaign);
      const variable = cleanText(body.variable, 60);
      const count = await updateState((state) => forgetSpoken(state, campaign, variable));
      return json(res, 200, { forgotten: count });
    }
    // The company's custom lead fields: shown on every lead's form and usable as script variables.
    if (url.pathname === "/api/settings/fields" && req.method === "PUT") {
      const { fields } = await getBody(req);
      const list = [...new Set((Array.isArray(fields) ? fields : []).map((field) => cleanText(field, 60)).filter(Boolean))].slice(0, 30);
      await updateState((state) => {
        state.settings = { ...(state.settings || {}), fields: list };
        activity(state, "Custom fields updated", list.join(", ") || "None");
      });
      return json(res, 200, { fields: list });
    }
    // Settings → Features & costs: switch paid or optional parts on and off.
    if (url.pathname === "/api/settings/features" && req.method === "PATCH") {
      const body = await getBody(req);
      const next = await updateState((state) => {
        const current = features(state);
        for (const key of Object.keys(featureDefaults)) if (typeof body[key] === "boolean") current[key] = body[key];
        state.settings = { ...(state.settings || {}), features: current };
        activity(state, "Features updated", Object.entries(current).map(([key, on]) => `${key} ${on ? "on" : "off"}`).join(", "));
        return current;
      });
      return json(res, 200, next);
    }
    // Settings → Email: the workspace's own Resend key and sender, so mail goes out from its own domain.
    if (url.pathname === "/api/email/settings" && req.method === "PUT") {
      const body = await getBody(req);
      const typed = cleanText(body.key, 200);
      const from = cleanText(body.from, 200);
      if (!/^([^<>]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(from)) return json(res, 400, { error: "Write the sender like Bayu <bayu@yourdomain.com>, on a domain you verified in Resend." });
      if (typed && !/^re_\w+/.test(typed)) return json(res, 400, { error: "That doesn't look like a Resend API key. They start with re_." });
      if (!typed && !(await readState()).email?.key) return json(res, 400, { error: "Paste your Resend API key." });
      await updateState((state) => {
        state.email = { key: typed ? seal(typed) : state.email.key, from, hint: typed ? `${typed.slice(0, 5)}…${typed.slice(-4)}` : state.email.hint };
        activity(state, "Email sender saved", from);
      });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/email/settings" && req.method === "DELETE") {
      await updateState((state) => {
        delete state.email;
        activity(state, "Email key removed", "");
      });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/email/test" && req.method === "POST") {
      const config = emailConfig(await readState());
      if (!config) return json(res, 400, { error: "Save a Resend key and sender first, and keep Email switched on." });
      try {
        await sendEmail(config, currentUser().email, "Open Dialer test email", ["This is a test from Open Dialer. If you got it, invites and password resets will reach your team."], { label: "Open Open Dialer", url: appUrl(req) });
      } catch (error) {
        return json(res, 502, { error: error.message });
      }
      return json(res, 200, { sentTo: currentUser().email });
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
      const lead = findLead(state, leadId);
      if (!lead) return json(res, 404, { error: "Lead not found." });
      if (lead.dnc) return json(res, 409, { error: "This contact is suppressed and cannot be called." });
      if (!state.connection?.selectedNumber) return json(res, 409, { error: "Connect Twilio and pick an outbound number in Settings first." });
      // The call record is created when Twilio actually starts the call (voice/client), so a blocked
      // microphone or failed connection never leaves a call stuck "In progress".
      const callId = `call_${Date.now()}_${randomBytes(3).toString("hex")}`;
      return json(res, 201, { callId, leadId: lead.id, userId: currentUser().id, token: voiceToken(lead.id, Date.now() + 10 * 60 * 1000) });
    }
    if (url.pathname === "/api/calls/start" && req.method === "POST") {
      const { leadId } = await getBody(req);
      const state = await readState();
      const lead = findLead(state, leadId);
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
      const statusUrl = statusUrlFor(req, lead.id);
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
        fresh.calls.unshift({ id: `call_${Date.now()}`, leadId: lead.id, outcome: "In progress", note: "Calling bridge started.", at: new Date().toISOString(), sid: remote.sid, userId: currentUser().id });
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
}
