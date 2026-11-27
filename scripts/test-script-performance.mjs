// Test call attribution against an isolated local server; no Twilio account or real data is used.
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createCipheriv, createHash } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "open-dialer-script-test-"));
copyFileSync(join(root, "server.mjs"), join(dir, "server.mjs"));
symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
mkdirSync(join(dir, "data"));
writeFileSync(join(dir, "mock-twilio.mjs"), `const original = globalThis.fetch; globalThis.fetch = (url, options) => String(url).startsWith('https://api.twilio.com/') ? Promise.resolve(new Response(JSON.stringify({ sid: 'CA_demo_bridge' }), { status: 201, headers: { 'content-type': 'application/json' } })) : original(url, options);`);
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const server = spawn(process.execPath, ["--import", "./mock-twilio.mjs", "server.mjs"], { cwd: dir, env: { ...process.env, PORT: String(port), DATABASE_URL: "", OPEN_DIALER_ENCRYPTION_KEY: "test-key-not-used-for-real-data", NODE_ENV: "development" }, stdio: "pipe" });
const base = `http://127.0.0.1:${port}`;
let cookie = "";
async function api(path, body, form = false, method = body ? "POST" : "GET") {
  const res = await fetch(base + path, { method, headers: { ...(body ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" } : {}), cookie }, body: body ? (form ? new URLSearchParams(body) : JSON.stringify(body)) : undefined });
  if (res.headers.get("set-cookie")) cookie = res.headers.get("set-cookie").split(";")[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  return text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
}
try {
  for (let i = 0; i < 50; i++) {
    try { await api("/api/session"); break; } catch (error) { if (i === 49) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  await api("/api/setup", { name: "Demo User", email: "demo@example.test", company: "Demo", password: "demo-password-123" });
  const iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update("test-key-not-used-for-real-data").digest(), iv);
  const encrypted = Buffer.concat([cipher.update("dummy-token"), cipher.final()]);
  writeFileSync(join(dir, "data", "open-dialer.json"), JSON.stringify({
    leads: [{ id: "lead_test", name: "Example", company: "Example", phone: "+12025550100", campaigns: ["Other", "Demo"], status: "New", due: "", dnc: false }],
    calls: [], activity: [], connection: { selectedNumber: "+12025550101", bridgeNumber: "+12025550102", accountSid: "AC_dummy", tokenCiphertext: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
    campaignSettings: { Other: { activeScript: "other", script: "Other script", scripts: [{ id: "other", name: "Other", script: "Other script" }] }, Demo: { activeScript: "s1", script: "First script", scripts: [{ id: "s1", name: "First", script: "First script" }, { id: "s2", name: "Second", script: "Second script" }] } },
  }));
  const started = await api("/api/calls/browser-start", { leadId: "lead_test", campaign: "Demo" });
  await api("/api/campaigns/script", { campaign: "Demo", activate: "s2" }, false, "PUT");
  await api("/api/twilio/voice/client", { leadId: "lead_test", callId: started.callId, token: started.token, userId: started.userId, scriptContext: started.scriptContext, CallSid: "CA_demo_test" }, true);
  await api("/api/calls/record", { leadId: "lead_test", callId: started.callId, outcome: "Meeting booked" });
  const state = await api("/api/state");
  const call = state.calls.find((item) => item.id === started.callId);
  const outcome = state.calls.find((item) => item.sourceCallId === started.callId);
  assert.equal(call.scriptId, "s1");
  assert.equal(call.scriptCampaign, "Demo");
  assert.equal(outcome.outcome, "Meeting booked");
  await api("/api/calls/record", { leadId: "lead_test", callId: started.callId, outcome: "Interested" });
  assert.equal((await api("/api/state")).calls.filter((item) => item.sourceCallId === started.callId).length, 1);
  const altered = await api("/api/calls/browser-start", { leadId: "lead_test", campaign: "Demo" });
  await api("/api/twilio/voice/client", { leadId: "lead_test", callId: altered.callId, token: altered.token, userId: altered.userId, scriptContext: `${altered.scriptContext}x`, CallSid: "CA_demo_tampered" }, true);
  assert.equal((await api("/api/state")).calls.find((item) => item.id === altered.callId).scriptId, undefined);
  const bridge = await api("/api/calls/start", { leadId: "lead_test", campaign: "Demo" });
  await api("/api/calls/record", { leadId: "lead_test", callId: bridge.callId, outcome: "Interested" });
  const bridgeState = await api("/api/state");
  assert.equal(bridgeState.calls.find((item) => item.id === bridge.callId).scriptId, "s2");
  assert.equal(bridgeState.calls.find((item) => item.sourceCallId === bridge.callId).outcome, "Interested");
  console.log("Script attribution: browser and bridge calls, selected campaign, snapshot, linking, duplicate and tamper checks passed.");
} finally {
  server.kill();
}
