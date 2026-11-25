// One-time setup after `npm install`: a PostgreSQL database for Open Dialer, and .env with its address and a fresh
// encryption key. Safe to run again: it keeps what's already there.
//   node scripts/setup.mjs            PostgreSQL on this computer. On Windows it's installed for you (winget) if
//                                     missing, with its data in this folder's data/postgres.
//   node scripts/setup.mjs --docker   PostgreSQL in Docker instead (port 5433, data in data/postgres).
// The Windows setup wizard (installer/OpenDialer.iss) runs this for you.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const dataDir = join(root, "data", "postgres");
const log = (message) => console.log(`[open-dialer] ${message}`);
const fail = (message) => { log(message); process.exit(1); };
const pause = (seconds) => spawnSync(process.platform === "win32" ? "timeout" : "sleep", process.platform === "win32" ? ["/t", String(seconds), "/nobreak"] : [String(seconds)], { stdio: "ignore", shell: process.platform === "win32" });
const secret = (bytes) => randomBytes(bytes).toString("hex");

// .env: keep what's there, add what's missing.
let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "# Made by scripts/setup.mjs. Keep this file private: it unlocks your saved Twilio, AI and email keys.\n";
const has = (name) => new RegExp(`^${name}=`, "m").test(env);
const saveEnv = (lines) => { env = `${env.trimEnd()}\n${lines.join("\n")}\n`; writeFileSync(envPath, env); };
if (!has("OPEN_DIALER_ENCRYPTION_KEY")) {
  saveEnv([`OPEN_DIALER_ENCRYPTION_KEY=${secret(32)}`]);
  log("Wrote a new encryption key to .env.");
}
if (has("DATABASE_URL")) {
  log(".env already has a database; keeping it.");
  done();
}

const password = secret(18);
if (process.argv.includes("--docker")) await dockerDatabase();
else await localDatabase();
done();

function done() {
  log('All set. Next: double-click "Start Open Dialer.bat" (or run: npm run local), then create your owner account in the browser.');
  process.exit(0);
}

// PostgreSQL installed on this computer: a role and database for Open Dialer.
async function localDatabase() {
  let bin = findPostgres();
  let superPassword = "";
  let port = 5432;
  if (!bin && process.platform === "win32") {
    // A fresh install: its data lives next to the app (on the drive you picked), not on C:.
    superPassword = secret(18);
    mkdirSync(join(root, "data"), { recursive: true });
    log("Installing PostgreSQL 17. Windows asks for permission; this takes a few minutes…");
    const winget = join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "winget.exe");
    const override = `--mode unattended --unattendedmodeui minimal --superpassword ${superPassword} --serverport ${port} --datadir "${dataDir}" --servicename open-dialer-postgres --disable-components pgAdmin,stackbuilder`;
    const installed = spawnSync(existsSync(winget) ? winget : "winget", ["install", "-e", "--id", "PostgreSQL.PostgreSQL.17", "--source", "winget", "--override", override], { stdio: "inherit" });
    bin = findPostgres();
    if (installed.status !== 0 && !bin) fail("PostgreSQL didn't install. Run this again, or install PostgreSQL 17 from https://www.postgresql.org/download/ and run it again.");
    saveEnv([`# The PostgreSQL superuser, made by this setup. Only needed for backups or admin work.`, `POSTGRES_SUPERUSER_PASSWORD=${superPassword}`]);
  }
  if (!bin) fail(process.platform === "darwin"
    ? "PostgreSQL isn't installed. Run: brew install postgresql@17 && brew services start postgresql@17   then run this again."
    : "PostgreSQL isn't installed. Install it (https://www.postgresql.org/download/), start it, then run this again.");
  const psql = join(bin, process.platform === "win32" ? "psql.exe" : "psql");
  // An existing install: on macOS/Linux your own user usually works without a password; on Windows ask for the
  // postgres password set when it was installed.
  const run = (sql, user) => spawnSync(psql, ["-h", "127.0.0.1", "-p", String(port), "-U", user, "-d", "postgres", "-tA", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", env: { ...process.env, PGPASSWORD: superPassword } });
  let user = process.platform === "win32" ? "postgres" : process.env.USER || "postgres";
  for (let tries = 0; tries < 30 && run("select 1", user).status !== 0 && superPassword; tries++) pause(2);
  if (run("select 1", user).status !== 0) {
    const ask = createInterface({ input: process.stdin, output: process.stdout });
    log("PostgreSQL is already on this computer. Open Dialer needs its admin login once to create its own database.");
    user = (await ask.question("[open-dialer] PostgreSQL admin user (Enter for postgres): ")).trim() || "postgres";
    superPassword = (await ask.question("[open-dialer] That user's password: ")).trim();
    port = Number((await ask.question("[open-dialer] Port (Enter for 5432): ")).trim()) || 5432;
    ask.close();
    const check = run("select 1", user);
    if (check.status !== 0) fail(`Couldn't sign in to PostgreSQL: ${check.stderr.trim()}`);
  }
  const quoted = password.replace(/'/g, "''");
  const role = run(`do $$ begin if exists (select from pg_roles where rolname = 'opendialer') then alter role opendialer login password '${quoted}'; else create role opendialer login password '${quoted}'; end if; end $$;`, user);
  if (role.status !== 0) fail(`Couldn't create the opendialer user: ${role.stderr.trim()}`);
  const exists = run("select 1 from pg_database where datname = 'opendialer'", user);
  if (exists.stdout.trim() !== "1") {
    const db = run("create database opendialer owner opendialer", user);
    if (db.status !== 0) fail(`Couldn't create the opendialer database: ${db.stderr.trim()}`);
  }
  saveEnv([`DATABASE_URL=postgres://opendialer:${password}@127.0.0.1:${port}/opendialer`]);
  log(`PostgreSQL is ready: database "opendialer" on port ${port}. The address is saved in .env.`);
}

// Where PostgreSQL's programs are: on PATH, or the newest version under Program Files on Windows.
function findPostgres() {
  if (process.platform === "win32") {
    const base = "C:\\Program Files\\PostgreSQL";
    const versions = existsSync(base) ? readdirSync(base).filter((name) => existsSync(join(base, name, "bin", "psql.exe"))).sort((a, b) => Number(b) - Number(a)) : [];
    if (versions.length) return join(base, versions[0], "bin");
  }
  const found = spawnSync(process.platform === "win32" ? "where" : "which", ["psql"], { encoding: "utf8" });
  return found.status === 0 ? dirname(found.stdout.split(/\r?\n/)[0].trim()) : "";
}

// PostgreSQL in Docker, on port 5433 with its files in data/postgres. Start Open Dialer.bat starts it each time.
async function dockerDatabase() {
  const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
  const dockerUp = () => docker("info").status === 0;
  const desktop = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
  if (!dockerUp() && process.platform === "win32" && existsSync(desktop)) {
    log("Opening Docker Desktop. The first start can take a few minutes…");
    spawnSync("cmd", ["/c", "start", "", desktop], { stdio: "ignore" });
    for (let tries = 0; tries < 60 && !dockerUp(); tries++) pause(3);
  }
  if (!dockerUp()) fail("Docker isn't running. Start Docker Desktop, finish its first-time setup, then run this again.");
  if (docker("container", "inspect", "open-dialer-db").status === 0) fail("A container called open-dialer-db already exists. Put its address in .env as DATABASE_URL, or remove it and run this again.");
  mkdirSync(dataDir, { recursive: true });
  const made = docker("run", "-d", "--name", "open-dialer-db", "--restart", "unless-stopped", "-e", "POSTGRES_USER=opendialer", "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=opendialer", "-e", "PGDATA=/var/lib/postgresql/data/pgdata", "-p", "127.0.0.1:5433:5432", "-v", `${dataDir}:/var/lib/postgresql/data`, "postgres:17-alpine");
  if (made.status !== 0) fail(`Couldn't create the database: ${(made.stderr || made.stdout).trim()}`);
  for (let tries = 0; tries < 30 && docker("exec", "open-dialer-db", "pg_isready", "-U", "opendialer").status !== 0; tries++) pause(2);
  saveEnv([`DATABASE_URL=postgres://opendialer:${password}@127.0.0.1:5433/opendialer`]);
  log(`PostgreSQL is ready in Docker. Its files are in ${dataDir}; back up the data folder.`);
}
