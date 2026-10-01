// npm run db:migrate — bring the configured database to the current schema and insert missing master data.
//
//   Local SQLite file (no TURSO_DATABASE_URL): same as a server start — backup first, then migrate + seed.
//   Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN): the ONLY way the remote schema changes. The deployed
//   app refuses to run against a remote database whose schema version does not match.
//   Turso keeps point-in-time backups; take a Turso branch/backup before migrating production data.
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const { openDatabase, migrate, seedMasterData, schemaVersion, SCHEMA_VERSION } = await import("../src/lib/server/db.ts");

const d = await openDatabase({ maintenance: true });
try {
  const before = await schemaVersion(d);
  console.log(`database : ${d.label} (${d.kind})`);
  console.log(`schema   : v${before} → target v${SCHEMA_VERSION}`);
  if (d.kind === "file") {
    d.close();
    const migrated = await openDatabase(); // file: migrates with backup + seeds
    console.log(`result   : v${await schemaVersion(migrated)}`);
    migrated.close();
  } else {
    await migrate(d);
    await d.transaction(() => seedMasterData(d));
    const fk = await d.all("PRAGMA foreign_key_check");
    console.log(`result   : v${await schemaVersion(d)}, foreign key violations: ${fk.length}`);
    d.close();
  }
} catch (err) {
  console.error(`MIGRATION FAILED: ${(err as Error).message}`);
  process.exit(1);
}
