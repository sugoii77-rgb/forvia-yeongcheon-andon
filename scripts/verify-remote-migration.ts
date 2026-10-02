// npm run db:verify-remote-migration — DRY RUN of the pending schema migration on the configured remote
// (Turso) database. Everything runs inside ONE write transaction that is always rolled back:
//   pending migrations + master-data seed → checks → ROLLBACK → check that nothing changed.
// Checks: target version reached, every pre-existing row / column of every existing table unchanged
// (checksums), foreign keys, append-only history. Use before `npm run db:migrate` on production:
//   vercel env run -e production -- npm run db:verify-remote-migration
// While it runs (seconds) other writes to the database wait. Prints counts only, no row contents.
import crypto from "node:crypto";
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const { openDatabase, migrate, seedMasterData, schemaVersion, SCHEMA_VERSION } = await import("../src/lib/server/db.ts");

const d = await openDatabase({ maintenance: true });
if (d.kind !== "remote") {
  console.error("Not a remote database (TURSO_DATABASE_URL not set). For a SQLite file use scripts/verify-google-migration.ts on a copy.");
  process.exit(2);
}
class Rollback extends Error {}
let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`  ${cond ? "✔" : "✖"} ${label}`);
  if (!cond) failures++;
};

const tables = async () =>
  (await d.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' ORDER BY name")).map((r) => r.name as string);

async function snapshot(names: string[], limits?: Record<string, number>) {
  const out: Record<string, { rows: number; sha256: string }> = {};
  for (const t of names) {
    const cols = (await d.all(`PRAGMA table_info("${t}")`)).map((c) => `"${c.name as string}"`);
    const where = limits ? `WHERE rowid <= ${limits[t]}` : "";
    const rows = await d.all(`SELECT ${cols.join(",")} FROM "${t}" ${where} ORDER BY rowid`);
    out[t] = { rows: rows.length, sha256: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
  }
  return out;
}

const started = Date.now();
try {
  const from = await schemaVersion(d);
  console.log(`database : ${d.label}`);
  console.log(`schema   : v${from} → v${SCHEMA_VERSION} (DRY RUN, rolled back)`);
  if (from === SCHEMA_VERSION) {
    console.log("Nothing to migrate.");
    process.exit(0);
  }
  const oldTables = await tables();
  const limits: Record<string, number> = {};
  for (const t of oldTables) limits[t] = Number((await d.get(`SELECT IFNULL(MAX(rowid), 0) AS m FROM "${t}"`))!.m);
  // old columns only: compare with the column list from before the migration
  const columnsBefore: Record<string, string[]> = {};
  for (const t of oldTables) columnsBefore[t] = (await d.all(`PRAGMA table_info("${t}")`)).map((c) => c.name as string);
  const before = await snapshot(oldTables);

  await d
    .transaction(async () => {
      await migrate(d);
      await seedMasterData(d);
      check((await schemaVersion(d)) === SCHEMA_VERSION, `migrated to v${SCHEMA_VERSION} inside the transaction`);
      let same = true;
      for (const t of oldTables.filter((x) => x !== "schema_meta")) { // schema_meta = the version row itself
        const rows = await d.all(`SELECT ${columnsBefore[t].map((c) => `"${c}"`).join(",")} FROM "${t}" WHERE rowid <= ${limits[t]} ORDER BY rowid`);
        const sha = crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
        if (rows.length !== before[t].rows || sha !== before[t].sha256) {
          same = false;
          console.log(`    changed: ${t}`);
        }
      }
      const total = Object.entries(before).filter(([t]) => t !== "schema_meta").reduce((n, [, x]) => n + x.rows, 0);
      check(same, `all ${total} pre-existing rows in ${oldTables.length - 1} data tables unchanged (old columns, checksums)`);
      check((await d.all("PRAGMA foreign_key_check")).length === 0, "no foreign key violations");
      check(await d.run("UPDATE andon_transition SET comment = comment").then(() => false, () => true), "andon_transition still append-only");
      const newTables = (await tables()).filter((t) => !oldTables.includes(t));
      console.log(`    new tables: ${newTables.join(", ") || "none"}`);
      throw new Rollback();
    })
    .catch((err) => {
      if (!(err instanceof Rollback)) throw err;
    });

  check((await schemaVersion(d)) === from, `after rollback still v${from}`);
  check(JSON.stringify(await tables()) === JSON.stringify(oldTables), "after rollback no new tables");
  check(JSON.stringify(await snapshot(oldTables, limits)) === JSON.stringify(before), "after rollback all data identical");
} catch (err) {
  failures++;
  console.error(`  ✖ ${(err as Error).message}`);
}
d.close();
console.log(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);
console.log(failures === 0 ? "DRY RUN PASSED — nothing was changed" : `${failures} CHECK(S) FAILED — nothing was changed`);
process.exit(failures === 0 ? 0 : 1);
