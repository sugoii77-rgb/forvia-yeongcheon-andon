// npm run purge:history -- [--before YYYY-MM-DD] [--out <folder>] [--yes] [--allow-remote]
//
// Retention (plant decision 2026-10-08): ANDON history is kept 1 year, then deleted. Before deleting, the
// events are saved as CSV (andon-history-<from>_<to>.csv, same format as /history → CSV 저장) in --out
// (default data/archive). Without --yes nothing is deleted (dry run: counts + CSV only).
//
// Deleted for each event created before the cut-off (default: today − 365 days, Korea time) and CLOSED:
// history rows, notification log, call departments / recipients, escalation record, the photo, the event.
// The append-only triggers are lifted only inside this one transaction and restored before it commits.
// Events that are still open are never deleted. The target database is the one the app uses; Turso
// only with --allow-remote (run via `vercel env run -e production --`).
import fs from "node:fs";
import path from "node:path";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const confirm = args.includes("--yes");
const kstDay = (offsetDays: number) => new Date(Date.now() + 9 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
const before = opt("--before") ?? kstDay(-365);
if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
  console.error("usage: npm run purge:history -- [--before YYYY-MM-DD] [--out <folder>] [--yes] [--allow-remote]");
  process.exit(2);
}
const outDir = path.resolve(opt("--out") ?? "data/archive");

const { db, REMOTE_DATABASE_URL } = await import("../src/lib/server/db.ts");
const { historyCsv } = await import("../src/lib/server/historyExport.ts");
const { deletePhoto } = await import("../src/lib/server/photos.ts");
if (REMOTE_DATABASE_URL && !args.includes("--allow-remote")) {
  console.error("Refusing to purge a remote (Turso) database without --allow-remote.");
  process.exit(2);
}

const TABLES = ["andon_transition", "notification_log", "andon_event_department", "andon_call_recipient", "andon_escalation"];

try {
  const cutIso = new Date(`${before}T00:00:00+09:00`).toISOString();
  const info = await db.info();
  const ids = (await db.all("SELECT id, photo_file FROM andon_event WHERE created_at < ? AND status = 'CLOSED' ORDER BY created_at", cutIso)) as { id: string; photo_file: string | null }[];
  const stillOpen = Number((await db.get("SELECT COUNT(*) AS n FROM andon_event WHERE created_at < ? AND status <> 'CLOSED'", cutIso))!.n);
  console.log(`database : ${info.label} (${info.kind})${confirm ? "" : "  — DRY RUN, nothing is deleted"}`);
  console.log(`cut-off  : events created before ${before} (Korea time)`);
  console.log(`events   : ${ids.length} completed to delete${stillOpen ? `, ${stillOpen} still open (kept)` : ""}`);
  if (ids.length === 0) process.exit(0);

  // 1) save locally first
  const first = (await db.get("SELECT MIN(created_at) AS t FROM andon_event WHERE created_at < ?", cutIso))!.t as string;
  const fromDay = new Date(new Date(first).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const { csv, rows } = await historyCsv(new Date(`${fromDay}T00:00:00+09:00`).toISOString(), cutIso);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `andon-history-${fromDay}_${before}.csv`);
  fs.writeFileSync(file, csv);
  console.log(`saved    : ${path.relative(process.cwd(), file)} (${rows} rows)`);
  if (!confirm) {
    console.log("Dry run: nothing deleted. Add --yes to delete after checking the CSV.");
    process.exit(0);
  }

  // 2) delete in one transaction; append-only triggers lifted and restored inside it
  const counts: Record<string, number> = {};
  await db.transaction(async () => {
    const triggers = (await db.all(
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${TABLES.map(() => "?").join(",")}) AND sql LIKE '%append-only%'`,
      ...TABLES,
    )) as { name: string; sql: string }[];
    for (const t of triggers) await db.exec(`DROP TRIGGER ${t.name}`);
    for (const { id } of ids) {
      for (const table of TABLES) counts[table] = (counts[table] ?? 0) + Number((await db.run(`DELETE FROM ${table} WHERE event_id = ?`, id)).changes);
      counts.andon_event = (counts.andon_event ?? 0) + Number((await db.run("DELETE FROM andon_event WHERE id = ? AND status = 'CLOSED'", id)).changes);
    }
    for (const t of triggers) await db.exec(t.sql);
    const restored = Number((await db.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${triggers.map(() => "?").join(",") || "''"})`, ...triggers.map((t) => t.name)))!.n);
    if (restored !== triggers.length) throw new Error("append-only triggers not restored — rolled back");
  });
  for (const { photo_file } of ids) if (photo_file) await deletePhoto(photo_file).catch(() => {});
  console.log(`deleted  : ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  process.exit(0);
} catch (err) {
  console.error(`PURGE FAILED (nothing deleted): ${(err as Error).message}`);
  process.exit(1);
}
