// Compare an OLDER backup with a migrated copy of it: every pre-existing row and column must be unchanged.
// Never operates on the live DB by default. (Originally written for v3→v4; works for any older version
// → the current schema.)
// Usage: node scripts/verify-google-migration.ts <old-backup.db> <copy-to-migrate.db> [report.json]
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const [beforePath, afterPath, reportPath] = process.argv.slice(2);
if (!beforePath || !afterPath || path.resolve(beforePath) === path.resolve(afterPath)) {
  throw new Error("Usage: node scripts/verify-google-migration.ts <old-backup> <copy-to-migrate> [report.json]");
}
const before = new DatabaseSync(beforePath, { readOnly: true });
const fromVersion = Number(before.prepare("PRAGMA user_version").get()?.user_version);
const tables = before
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => String(r.name));
const projections = new Map(
  tables.map((t) => [
    t,
    before
      .prepare(`PRAGMA table_info("${t}")`)
      .all()
      .map((r) => `"${r.name}"`)
      .join(","),
  ]),
);
// Pre-existing rows = rowid <= the highest rowid in the backup. Master-data seeding after a migration
// may ADD rows (e.g. new lines in v6); those are reported, never compared.
const maxRowid = new Map(tables.map((t) => [t, Number(before.prepare(`SELECT IFNULL(MAX(rowid), 0) AS m FROM "${t}"`).get()?.m)]));
type Snapshot = Record<string, { count: number; sha256: string }>;
async function snapshot(all: (sql: string) => Promise<unknown[]>): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const t of tables) {
    const rows = await all(`SELECT ${projections.get(t)} FROM "${t}" WHERE rowid <= ${maxRowid.get(t)} ORDER BY rowid`);
    out[t] = { count: rows.length, sha256: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
  }
  return out;
}
const baseline = await snapshot(async (sql) => before.prepare(sql).all());
before.close();

process.env.DATABASE_PATH = path.resolve(afterPath);
process.env.UPLOAD_DIR = path.resolve("work/google/uploads");
delete process.env.TURSO_DATABASE_URL; // always the local copy
const { db, SCHEMA_VERSION } = await import("../src/lib/server/db.ts");
const toVersion = Number((await db.get("PRAGMA user_version"))?.user_version);
assert.ok(fromVersion < SCHEMA_VERSION, `backup must be older than v${SCHEMA_VERSION} (is v${fromVersion})`);
assert.equal(toVersion, SCHEMA_VERSION);
assert.deepEqual(
  await snapshot((sql) => db.all(sql)),
  baseline,
  "All old columns/rows including history, events, notifications, routing and identities must match",
);
const added: Record<string, number> = {};
for (const t of tables) {
  const n = Number((await db.get(`SELECT COUNT(*) AS n FROM "${t}" WHERE rowid > ${maxRowid.get(t)}`))?.n);
  if (n) added[t] = n;
}
assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
assert.equal((await db.get("PRAGMA integrity_check"))?.integrity_check, "ok");
await assert.rejects(() => db.exec("UPDATE andon_transition SET comment='tamper'"), /append-only/);
const report = {
  from: fromVersion,
  to: toVersion,
  verifiedAt: new Date().toISOString(),
  allExistingRowsAndColumnsUnchanged: true,
  rowsAddedBySeed: added,
  tables: baseline,
  foreignKeys: "PASS",
  integrity: "ok",
  appendOnly: "PASS",
};
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
