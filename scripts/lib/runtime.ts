// Shared helpers for the supervisor / stop / status scripts (no dependencies).
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
process.chdir(ROOT);
if (fs.existsSync(".env")) process.loadEnvFile(".env");

export const PORT = Number(process.env.PORT || 3000);
/** Optional bind address. Default: all interfaces (needed for phones on the LAN). */
export const HOST = process.env.HOST || "";
export const RUN_DIR = path.join(ROOT, "data", "run");
export const LOG_DIR = path.join(ROOT, "data", "logs");
export const SUPERVISOR_PID_FILE = path.join(RUN_DIR, "supervisor.pid");
export const SERVER_PID_FILE = path.join(RUN_DIR, "server.pid");
export const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
export const HEALTH_URL = `http://127.0.0.1:${PORT}${process.env.WATCHDOG_HEALTH_PATH || "/api/health"}`;

const isWin = process.platform === "win32";

export function readPid(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePid(file: string, pid: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(pid));
}

export function removePid(file: string, onlyIf?: number) {
  if (onlyIf != null && readPid(file) !== onlyIf) return;
  fs.rmSync(file, { force: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Full command line of a process ("" if unknown). Used to make sure a PID really is ours before killing it. */
export function commandLine(pid: number): string {
  try {
    if (isWin) {
      const r = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: "utf8", timeout: 15000, windowsHide: true },
      );
      return (r.stdout || "").trim();
    }
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return "";
  }
}

/** PID listening on the TCP port, or null. */
export function portOwner(port: number): number | null {
  try {
    if (isWin) {
      const r = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
        ],
        { encoding: "utf8", timeout: 15000, windowsHide: true },
      );
      const pid = Number((r.stdout || "").trim());
      return pid > 0 ? pid : null;
    }
    const r = spawnSync("sh", ["-c", `lsof -t -iTCP:${port} -sTCP:LISTEN | head -1`], { encoding: "utf8" });
    const pid = Number((r.stdout || "").trim());
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export const DATABASE_PATH = path.resolve(process.env.DATABASE_PATH || "./data/andon.db");

const norm = (s: string) => s.toLowerCase().replaceAll("/", "\\");

/**
 * True only if the process is a Next server of THIS project: its command line names this folder,
 * or (for a server started with a relative path) it answers /api/health with this project's DB file.
 * Never matches other Next.js apps on the same PC.
 */
export function isOurServer(cmd: string, healthBody?: unknown): boolean {
  const c = norm(cmd);
  if (!c.includes("next")) return false;
  if (c.includes(norm(ROOT) + "\\")) return true;
  const db = (healthBody as { db?: string } | null | undefined)?.db;
  return typeof db === "string" && norm(db) === norm(DATABASE_PATH);
}

/** Kill a process and all its children. */
export function killTree(pid: number) {
  if (isWin) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

export async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

export async function fetchHealth(timeoutMs = 5000): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => null);
    return { ok: res.ok && (body as { ok?: boolean } | null)?.ok === true, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: String(err) };
  }
}

/** Korea-time date for log file names. */
export function kstDate(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

export function logFile(): string {
  return path.join(LOG_DIR, `andon-${kstDate()}.log`);
}
