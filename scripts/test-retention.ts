// Retention tests (npm run test:retention): purge:history on a fresh isolated DB under work/retention-test/.
// Events older than one year that are completed are saved as CSV and deleted; open ones stay; the
// append-only protection is back afterwards; newer events are untouched. Never Turso.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DIR = path.resolve("work/retention-test", `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`);
fs.mkdirSync(DIR, { recursive: true });
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.DATABASE_PATH = path.join(DIR, "retention.db");
process.env.UPLOAD_DIR = path.join(DIR, "uploads");

const { db } = await import("../src/lib/server/db.ts");
const andon = await import("../src/lib/server/andonService.ts");

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`  ${cond ? "✔" : "✖"} ${label}`);
  if (!cond) failures++;
};

const p = (await db.get("SELECT p.id, p.line_code FROM process p JOIN line l ON l.code = p.line_code WHERE p.active = 1 AND l.active = 1 ORDER BY p.id LIMIT 1")) as { id: number; line_code: string };
const day = 86_400_000;
const mk = async (ageDays: number, close: boolean, d: string) => {
  const at = new Date(Date.now() - ageDays * day).toISOString();
  const e = (await andon.createEvent({ lineCode: p.line_code, processId: p.id, categoryCode: "MAINTENANCE", description: d, createdBy: "test", createdAt: at })).event;
  if (close) {
    await andon.transitionEvent(e.id, { action: "ACKNOWLEDGE", userName: "보전 담당", at });
    await andon.transitionEvent(e.id, { action: "CLOSE", userName: "보전 담당", comment: "[TEST] done", at });
  }
  return e.id;
};
const old1 = await mk(400, true, "[TEST] old closed 1, \"quoted\"");
const old2 = await mk(380, true, "[TEST] old closed 2");
const oldOpen = await mk(390, false, "[TEST] old but still open");
const recent = await mk(30, true, "[TEST] recent closed");
await db.run("INSERT INTO notification_log (event_id, provider, recipient, status, message, error, created_at) VALUES (?, 'mock', 'x', 'SENT', 'm', NULL, ?)", old1, new Date().toISOString());

const run = (...a: string[]) => spawnSync(process.execPath, ["scripts/purge-history.ts", ...a], { encoding: "utf8", env: process.env });
const out = path.join(DIR, "archive");

console.log("Retention (isolated DB)");
const dry = run("--out", out);
check(dry.status === 0 && /2 completed to delete, 1 still open/.test(dry.stdout), "dry run: 2 completed old events found, the open one kept");
check(Number((await db.get("SELECT COUNT(*) n FROM andon_event"))!.n) >= 4 && !!(await db.get("SELECT 1 FROM andon_event WHERE id = ?", old1)), "dry run deletes nothing");
const files = fs.readdirSync(out);
const csv = fs.readFileSync(path.join(out, files[0]), "utf8");
check(files.length === 1 && csv.startsWith("﻿") && csv.includes(old1) && csv.includes(old2) && !csv.includes(recent), "CSV saved locally before anything is deleted (old events only, Excel BOM)");
check(csv.includes('"[TEST] old closed 1, ""quoted"""'), "CSV quoting of commas / quotes");

const real = run("--out", out, "--yes");
check(real.status === 0, `purge with --yes succeeds (${real.stderr.trim() || "ok"})`);
const left = (await db.all("SELECT id FROM andon_event WHERE id IN (?, ?, ?, ?)", old1, old2, oldOpen, recent)).map((r) => r.id);
check(!left.includes(old1) && !left.includes(old2) && left.includes(oldOpen) && left.includes(recent), "old completed events deleted; old open + recent kept");
check(!(await db.get("SELECT 1 FROM andon_transition WHERE event_id IN (?, ?)", old1, old2)) && !(await db.get("SELECT 1 FROM notification_log WHERE event_id = ?", old1)), "their history and notification log deleted too");
check(Number((await db.get("SELECT COUNT(*) n FROM andon_transition WHERE event_id = ?", recent))!.n) === 3, "recent history untouched");
let blocked = false;
try {
  await db.run("DELETE FROM andon_transition WHERE event_id = ?", recent);
} catch {
  blocked = true;
}
check(blocked, "append-only protection is back after the purge");

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
