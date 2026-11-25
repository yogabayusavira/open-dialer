// One-time setup after `npm install`: writes .env with fresh secrets and creates the local Postgres database in
// Docker, with its files in this folder's data/postgres. Safe to run again: it keeps what's already there.
// Run: node scripts/setup.mjs   (Install Open Dialer.bat runs it for you on Windows)
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const log = (message) => console.log(`[open-dialer] ${message}`);
const pause = (seconds) => spawnSync(process.platform === "win32" ? "timeout" : "sleep", process.platform === "win32" ? ["/t", String(seconds), "/nobreak"] : [String(seconds)], { stdio: "ignore", shell: process.platform === "win32" });
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });

// 1. .env with a database password and an encryption key nobody else has.
const hadEnv = existsSync(envPath);
let env = hadEnv ? readFileSync(envPath, "utf8") : "";
let password = env.match(/^DATABASE_URL=postgres(?:ql)?:\/\/opendialer:([^@]+)@127\.0\.0\.1:5433\//m)?.[1];
if (!env.trim()) {
  password = randomBytes(18).toString("hex");
  env = [
    "# Made by scripts/setup.mjs. Keep this file private: it unlocks your saved Twilio and AI keys.",
    `DATABASE_URL=postgres://opendialer:${password}@127.0.0.1:5433/opendialer`,
    `OPEN_DIALER_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`,
    "",
  ].join("\n");
  writeFileSync(envPath, env);
  log("Wrote .env with a new database password and encryption key.");
} else log(".env already exists; keeping it.");
if (!password) {
  log("Your .env uses a database other than the local Docker one, so there's nothing more to set up.");
  log('Next: double-click "Start Open Dialer.bat" (or run: npm run local).');
  process.exit(0);
}

// 2. Docker has to be running. On Windows, open Docker Desktop and wait for it.
const dockerUp = () => docker("info").status === 0;
if (!dockerUp()) {
  const desktop = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
  if (process.platform === "win32" && existsSync(desktop)) {
    log("Opening Docker Desktop. The first start can take a few minutes…");
    spawnSync("cmd", ["/c", "start", "", desktop], { stdio: "ignore" });
    for (let tries = 0; tries < 60 && !dockerUp(); tries++) pause(3);
  }
}
if (!dockerUp()) {
  log("Docker isn't running. Start Docker Desktop, finish its first-time setup (it may ask you to restart), then run this again.");
  process.exit(1);
}

// 3. The database container, keeping its files next to the app.
const exists = docker("container", "inspect", "open-dialer-db").status === 0;
if (exists) {
  docker("start", "open-dialer-db");
  log("The database container already exists; started it.");
  if (!hadEnv) log("Note: it keeps the password it was made with. If you just made a new .env, put that old password in DATABASE_URL.");
} else {
  const data = join(root, "data", "postgres");
  mkdirSync(data, { recursive: true });
  const made = docker("run", "-d", "--name", "open-dialer-db", "--restart", "unless-stopped", "-e", "POSTGRES_USER=opendialer", "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=opendialer", "-e", "PGDATA=/var/lib/postgresql/data/pgdata", "-p", "127.0.0.1:5433:5432", "-v", `${data}:/var/lib/postgresql/data`, "postgres:17-alpine");
  if (made.status !== 0) {
    log(`Couldn't create the database: ${(made.stderr || made.stdout).trim()}`);
    process.exit(1);
  }
  log(`Created the database. Its files are in ${data}; back up the data folder.`);
}
let ready = false;
for (let tries = 0; tries < 30 && !ready; tries++) {
  ready = docker("exec", "open-dialer-db", "pg_isready", "-U", "opendialer").status === 0;
  if (!ready) pause(2);
}
log(ready ? "The database is ready." : "The database is still starting; that's fine, the app waits for it.");
log('All set. Next: double-click "Start Open Dialer.bat" (or run: npm run local), then create your owner account in the browser.');
