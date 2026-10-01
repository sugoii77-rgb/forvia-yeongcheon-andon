// Consistent online backup of the SQLite DB (safe while the app is running).
// Usage: npm run backup   -> data/backups/andon-<timestamp>.db
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const dbPath = path.resolve(process.env.DATABASE_PATH || "./data/andon.db");
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  process.exit(1);
}
const dir = path.join(path.dirname(dbPath), "backups");
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, `andon-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000;");
// VACUUM INTO a short temp path first: SQLite on Windows fails on paths > 260 chars,
// Node fs does not. Then move the snapshot next to the DB.
const tmp = path.join(os.tmpdir(), `andon-backup-${process.pid}.db`);
fs.rmSync(tmp, { force: true });
db.prepare("VACUUM INTO ?").run(tmp);
fs.copyFileSync(tmp, target);
fs.rmSync(tmp, { force: true });
db.close();
console.log(`Backup written: ${target}`);
