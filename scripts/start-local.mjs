// Runs Open Dialer on this computer with calling working: builds the app, opens a Cloudflare quick tunnel
// so Twilio can reach it, then starts the server with that public address. Ctrl+C stops both.
// Hosted copies (Dokploy) don't need this: they set OPEN_DIALER_PUBLIC_URL to their real domain.
// Run: npm run local   (or double-click "Start Open Dialer.bat" on Windows)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const port = Number(process.env.PORT || 3000);
const log = (message) => console.log(`[open-dialer] ${message}`);

function findCloudflared() {
  const candidates = [process.env.CLOUDFLARED, "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe"].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (found) return found;
  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["cloudflared"], { encoding: "utf8" });
  return onPath.status === 0 ? onPath.stdout.split(/\r?\n/)[0].trim() : null;
}

// Starts a quick tunnel and resolves with its https address, or null if it doesn't come up in time.
function startTunnel(cloudflared) {
  // An empty config, so the tunnel doesn't pick up ~/.cloudflared/config.yml from another project.
  const config = join(tmpdir(), "open-dialer-cloudflared.yml");
  writeFileSync(config, "# Open Dialer quick tunnel: intentionally empty\n");
  const tunnel = spawn(cloudflared, ["tunnel", "--config", config, "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  const address = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 45_000);
    const watch = (chunk) => {
      const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    tunnel.stdout.on("data", watch);
    tunnel.stderr.on("data", watch);
    tunnel.on("exit", () => { clearTimeout(timer); resolve(null); });
  });
  return { tunnel, address };
}

// The database can run in Docker on this computer (container open-dialer-db, see .env). Start it and wait until it answers.
const envText = existsSync(join(root, ".env")) ? readFileSync(join(root, ".env"), "utf8") : "";
if (/^DATABASE_URL=.*@127\.0\.0\.1:5433\//m.test(envText)) {
  const pause = (seconds) => spawnSync(process.platform === "win32" ? "timeout" : "sleep", process.platform === "win32" ? ["/t", String(seconds), "/nobreak"] : [String(seconds)], { stdio: "ignore" });
  const dockerUp = () => spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
  // Docker Desktop closed: open it and wait for it (it takes up to a minute or two after a restart).
  const desktop = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
  if (!dockerUp() && process.platform === "win32" && existsSync(desktop)) {
    log("Opening Docker Desktop for the database…");
    spawn(desktop, [], { detached: true, stdio: "ignore" }).unref();
    for (let tries = 0; tries < 60 && !dockerUp(); tries++) pause(3);
  }
  log("Starting the local database (Docker)…");
  const started = spawnSync("docker", ["start", "open-dialer-db"], { encoding: "utf8" });
  if (started.status !== 0) {
    log("Couldn't start the database. Open Docker Desktop, wait until it says it's running, then start Open Dialer again.");
    process.exit(1);
  }
  let ready = false;
  for (let tries = 0; tries < 30 && !ready; tries++) {
    ready = spawnSync("docker", ["exec", "open-dialer-db", "pg_isready", "-U", "opendialer"]).status === 0;
    if (!ready) pause(2);
  }
  if (!ready) log("The database is slow to start; Open Dialer will keep trying.");
}

log("Building the app…");
const build = spawnSync("npm run build", { cwd: root, stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status || 1);

const children = [];
const stopAll = () => { for (const child of children) if (!child.killed) child.kill(); };
process.on("SIGINT", () => { stopAll(); process.exit(0); });
process.on("SIGTERM", () => { stopAll(); process.exit(0); });

const env = { ...process.env, PORT: String(port) };
const cloudflared = findCloudflared();
if (!cloudflared) {
  log("cloudflared isn't installed, so Twilio can't reach this computer and calls won't connect.");
  log("Install it with: winget install --id Cloudflare.cloudflared   then start again.");
} else {
  log("Opening a Cloudflare tunnel so Twilio can reach the app…");
  const { tunnel, address } = startTunnel(cloudflared);
  children.push(tunnel);
  const url = await address;
  if (url) {
    // An address set in the environment wins over the one in .env.
    env.OPEN_DIALER_PUBLIC_URL = url;
    log(`Twilio will reach the app at ${url}`);
  } else {
    log("The tunnel didn't start in time. The app runs, but calls won't connect until you start again.");
  }
}

const args = existsSync(join(root, ".env")) ? ["--env-file=.env", "server.mjs"] : ["server.mjs"];
const server = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "inherit"] });
children.push(server);
let opened = false;
server.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (!opened && /listening on/.test(String(chunk))) {
    opened = true;
    const local = `http://localhost:${port}`;
    log(`Open Dialer is running at ${local}. Keep this window open while you call; Ctrl+C stops everything.`);
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", local], { stdio: "ignore", detached: true }).unref();
  }
});
server.on("exit", (code) => { stopAll(); process.exit(code ?? 0); });
