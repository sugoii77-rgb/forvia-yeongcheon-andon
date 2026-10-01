// Digital ANDON process supervisor — keeps the production server running.
//
//   npm run serve     start (foreground; used by the Windows auto-start task)
//   npm run status    show state + health + recent log
//   npm run stop      stop supervisor and server
//
// What it does:
//  - refuses to start twice; kills a stale server left over from a previous run (only if it is provably ours)
//  - rebuilds automatically if the production build is missing (.next/BUILD_ID)
//  - starts `next start` directly (no npm wrapper, so no orphaned child processes)
//  - restarts the server if it exits, with back-off (1 s … 30 s)
//  - watchdog: restarts the server if /api/health fails 3 times in a row (hung process, DB failure)
//  - logs everything to data/logs/andon-YYYY-MM-DD.log (kept 30 days)
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  HOST,
  LOG_DIR,
  NEXT_BIN,
  PORT,
  ROOT,
  SERVER_PID_FILE,
  SUPERVISOR_PID_FILE,
  commandLine,
  fetchHealth,
  isAlive,
  isOurServer,
  isPortOpen,
  killTree,
  logFile,
  portOwner,
  readPid,
  removePid,
  waitUntil,
  writePid,
} from "./lib/runtime.ts";

const STARTUP_GRACE_MS = 30_000;
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 15_000);
const WATCHDOG_MAX_FAILURES = 3;
const BACKOFF_S = [1, 2, 5, 10, 30];
const STABLE_RESET_MS = 60_000;
const LOG_RETENTION_DAYS = 30;

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(source: "supervisor" | "server", line: string) {
  const text = `${new Date().toISOString()} [${source}] ${line}`;
  console.log(text);
  try {
    fs.appendFileSync(logFile(), text + "\n");
  } catch {
    // logging must never stop the supervisor
  }
}
const say = (line: string) => log("supervisor", line);

function pruneOldLogs() {
  const limit = Date.now() - LOG_RETENTION_DAYS * 86400_000;
  for (const f of fs.readdirSync(LOG_DIR)) {
    const p = path.join(LOG_DIR, f);
    try {
      if (fs.statSync(p).mtimeMs < limit) fs.rmSync(p);
    } catch {}
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- pre-flight

function ensureSingleInstance() {
  const other = readPid(SUPERVISOR_PID_FILE);
  if (other && other !== process.pid && isAlive(other) && commandLine(other).includes("supervisor")) {
    say(`another supervisor is already running (PID ${other}). Use "npm run stop" first. Exiting.`);
    process.exit(1);
  }
  writePid(SUPERVISOR_PID_FILE, process.pid);
}

/** Frees the port if it is held by a stale server of THIS project; waits if another program holds it. */
async function freePort(): Promise<void> {
  const stale = readPid(SERVER_PID_FILE);
  if (stale && isAlive(stale) && isOurServer(commandLine(stale))) {
    say(`stopping stale ANDON server from a previous run (PID ${stale})`);
    killTree(stale);
    await waitUntil(() => !isAlive(stale), 10_000);
  }
  removePid(SERVER_PID_FILE);

  for (;;) {
    if (!(await isPortOpen(PORT))) return;
    const owner = portOwner(PORT);
    const cmd = owner ? commandLine(owner) : "";
    const health = await fetchHealth(3000);
    if (owner && isOurServer(cmd, health.body)) {
      say(`port ${PORT} is held by an unmanaged ANDON server of this project (PID ${owner}); stopping it`);
      killTree(owner);
      await waitUntil(async () => !(await isPortOpen(PORT)), 10_000);
      continue;
    }
    say(`port ${PORT} is used by another program (PID ${owner ?? "?"}: ${cmd || "unknown"}). Retrying in 30 s. Change PORT in .env if this persists.`);
    await sleep(30_000);
  }
}

async function ensureBuild(): Promise<void> {
  for (;;) {
    if (fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) return;
    say("production build missing (.next/BUILD_ID) — running `next build` (about 1 minute)…");
    const r = spawnSync(process.execPath, [NEXT_BIN, "build"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", NEXT_TELEMETRY_DISABLED: "1" },
      windowsHide: true,
    });
    for (const line of `${r.stdout ?? ""}${r.stderr ?? ""}`.split(/\r?\n/)) if (line.trim()) log("server", `[build] ${line}`);
    if (r.status === 0 && fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
      say("build finished");
      return;
    }
    say(`build FAILED (exit ${r.status}). Retrying in 60 s — see log above.`);
    await sleep(60_000);
  }
}

// ---------------------------------------------------------------- run loop

let child: ChildProcess | null = null;
let stopping = false;
let watchdog: NodeJS.Timeout | null = null;

function pipeOutput(stream: NodeJS.ReadableStream | null) {
  if (!stream) return;
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) log("server", l);
  });
}

function startWatchdog(target: ChildProcess) {
  const startedAt = Date.now();
  let failures = 0;
  watchdog = setInterval(async () => {
    if (stopping || child !== target || Date.now() - startedAt < STARTUP_GRACE_MS) return;
    const h = await fetchHealth(5000);
    if (h.ok) {
      if (failures > 0) say(`health check recovered after ${failures} failure(s)`);
      failures = 0;
      return;
    }
    failures++;
    say(`health check failed (${failures}/${WATCHDOG_MAX_FAILURES}): HTTP ${h.status} ${JSON.stringify(h.body).slice(0, 200)}`);
    if (failures >= WATCHDOG_MAX_FAILURES && target.pid) {
      say(`server unhealthy — restarting (killing PID ${target.pid})`);
      failures = 0;
      killTree(target.pid);
    }
  }, WATCHDOG_INTERVAL_MS);
}

function runServer(): Promise<{ code: number | null; ranMs: number }> {
  return new Promise((resolve) => {
    const args = [NEXT_BIN, "start", "-p", String(PORT)];
    if (HOST) args.push("-H", HOST);
    const started = Date.now();
    const c = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child = c;
    if (c.pid) writePid(SERVER_PID_FILE, c.pid);
    say(`server started (PID ${c.pid}) on port ${PORT}${HOST ? ` host ${HOST}` : " (all interfaces)"}`);
    pipeOutput(c.stdout);
    pipeOutput(c.stderr);
    startWatchdog(c);
    c.on("error", (err) => say(`could not start server: ${err.message}`));
    c.on("exit", (code, signal) => {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      if (c.pid) removePid(SERVER_PID_FILE, c.pid);
      child = null;
      say(`server exited (code ${code}${signal ? `, signal ${signal}` : ""}) after ${Math.round((Date.now() - started) / 1000)} s`);
      resolve({ code, ranMs: Date.now() - started });
    });
  });
}

async function main() {
  say(`supervisor starting (PID ${process.pid}, node ${process.version}, folder ${ROOT})`);
  ensureSingleInstance();
  pruneOldLogs();

  let attempt = 0;
  while (!stopping) {
    await freePort();
    await ensureBuild();
    if (stopping) break;
    const { ranMs } = await runServer();
    if (stopping) break;
    if (ranMs > STABLE_RESET_MS) attempt = 0;
    const wait = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)];
    attempt++;
    say(`restarting in ${wait} s (attempt ${attempt})`);
    await sleep(wait * 1000);
  }
}

function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  say(`stopping (${reason})`);
  if (watchdog) clearInterval(watchdog);
  if (child?.pid) killTree(child.pid);
  removePid(SERVER_PID_FILE);
  removePid(SUPERVISOR_PID_FILE, process.pid);
  setTimeout(() => process.exit(0), 500);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
  process.on(sig, () => shutdown(sig));
}
process.on("exit", () => removePid(SUPERVISOR_PID_FILE, process.pid));
process.on("uncaughtException", (err) => say(`supervisor error (continuing): ${err.stack ?? err}`));
process.on("unhandledRejection", (err) => say(`supervisor error (continuing): ${String(err)}`));

main().catch((err) => {
  say(`supervisor crashed: ${err?.stack ?? err}`);
  if (child?.pid) killTree(child.pid);
  process.exit(1);
});
