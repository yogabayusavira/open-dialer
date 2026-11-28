// Run: node scripts/test-automation-runner.mjs (about a minute: it waits for the Wait to resume).
// Isolated end-to-end check of the automation runner: a throwaway server (own empty file store, no database), one
// "Call outcome logged" automation with a fan-out from the trigger, an If with Yes/No branches and a Wait.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const serverFile = process.argv[2] || fileURLToPath(new URL("../server.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "od-runner-"));
const port = 3999;
const server = spawn(process.execPath, [serverFile], { cwd: dir, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PORT: String(port), OPEN_DIALER_ENCRYPTION_KEY: randomBytes(32).toString("hex") }, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (chunk) => (output += chunk));
server.stderr.on("data", (chunk) => (output += chunk));
const base = `http://127.0.0.1:${port}`;
let cookie = "";
async function call(path, method = "GET", body) {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = response.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path} ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
try {
  for (let tries = 0; tries < 50; tries++) {
    try { await fetch(base + "/api/session"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  await call("/api/setup", "POST", { name: "Test Owner", email: "owner@example.test", company: "Test", password: "test-password-123" });
  const a = await call("/api/leads", "POST", { name: "Lead A", phone: "+12025550101", company: "A Co", details: { Tier: "A" } });
  const b = await call("/api/leads", "POST", { name: "Lead B", phone: "+12025550102", company: "B Co", details: { Tier: "B" } });
  const flow = {
    id: "au_test", name: "Branch test", on: true, trigger: "outcome", campaigns: [], outcomes: ["Callback"],
    nodes: [
      { id: "trigger", step: null, x: 0, y: 0 },
      { id: "tier", step: { type: "if", field: "detail:Tier", op: "is", value: "A" }, x: 300, y: 0 },
      { id: "booked", step: { type: "stage", stage: "Meeting booked" }, x: 600, y: -80 },
      { id: "later", step: { type: "followup", days: 3 }, x: 600, y: 80 },
      { id: "wait", step: { type: "wait", amount: 1, unit: "minutes" }, x: 300, y: 200 },
      { id: "won", step: { type: "stage", stage: "Won" }, x: 600, y: 200 },
    ],
    edges: [
      { from: "trigger", port: "out", to: "tier" },
      { from: "trigger", port: "out", to: "wait" },
      { from: "tier", port: "yes", to: "booked" },
      { from: "tier", port: "no", to: "later" },
      { from: "wait", port: "out", to: "won" },
    ],
  };
  const saved = await call("/api/automations", "PUT", { automations: [flow] });
  assert.equal(saved[0].edges.length, 5, "all five connections kept");
  const leadA = a.id || a.lead?.id || a.leads?.[0]?.id;
  const leadB = b.id || b.lead?.id || b.leads?.[0]?.id;
  await call("/api/calls/record", "POST", { leadId: leadA, outcome: "Callback", note: "" });
  await call("/api/calls/record", "POST", { leadId: leadB, outcome: "Callback", note: "" });
  const state = await call("/api/state");
  const after = (id) => state.leads.find((lead) => lead.id === id);
  const jobs = state.scheduled || [];
  const log = state.activity.map((item) => `${item.action} · ${item.detail}`);
  const result = {
    leadA: { status: after(leadA).status, due: after(leadA).due },
    leadB: { status: after(leadB).status, due: after(leadB).due },
    waits: jobs.map((job) => ({ lead: job.leadId === leadA ? "A" : "B", next: job.next })),
    log: log.filter((line) => line.startsWith("Automation")),
  };
  console.log(JSON.stringify(result, null, 2));
  // Yes branch: A moves to Meeting booked. No branch: B gets a follow-up date, stays out of Meeting booked.
  assert.equal(result.leadA.status, "Meeting booked");
  assert.notEqual(result.leadB.status, "Meeting booked");
  assert.match(result.leadB.due, /^\d{4}-\d{2}-\d{2}/);
  // The trigger's second branch waits on its own for both leads, resuming at "won".
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((job) => job.next), [["won"], ["won"]]);
  console.log("PASS branches");
  // The minute ticker resumes each wait at its next node: both leads end up Won.
  let resumed = null;
  for (let tries = 0; tries < 30 && !resumed; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const later = await call("/api/state");
    const statuses = [leadA, leadB].map((id) => later.leads.find((lead) => lead.id === id).status);
    if (statuses.every((status) => status === "Won") && !(later.scheduled || []).length) resumed = statuses;
  }
  assert.ok(resumed, "waits resumed and moved both leads to Won");
  console.log("PASS wait resumed:", resumed.join(", "));
} catch (error) {
  console.error("FAIL", error.message, "\n", output.slice(-2000));
  process.exitCode = 1;
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(dir, { recursive: true, force: true });
}
