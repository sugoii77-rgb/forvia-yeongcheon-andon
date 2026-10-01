// SQLite access via Node's built-in `node:sqlite` (Node >= 22.13; project uses Node 24).
// One file = the whole database. Backup = copy the file (or use `npm run backup`).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { CATEGORIES, DEPARTMENTS, LINES, PROCESSES, USERS } from "./masterData.ts";

export const DATABASE_PATH = path.resolve(/*turbopackIgnore: true*/ process.env.DATABASE_PATH || "./data/andon.db");
export const UPLOAD_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR || "./data/uploads");

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS department (
  code        TEXT PRIMARY KEY,
  name_ko     TEXT NOT NULL,
  name_en     TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS category (
  code               TEXT PRIMARY KEY,
  name_ko            TEXT NOT NULL,
  name_en            TEXT NOT NULL,
  default_department TEXT NOT NULL REFERENCES department(code),
  sort_order         INTEGER NOT NULL DEFAULT 0,
  active             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS line (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS process (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  line_code   TEXT NOT NULL REFERENCES line(code),
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (line_code, name)
);

CREATE TABLE IF NOT EXISTS app_user (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  department_code TEXT NOT NULL REFERENCES department(code),
  role            TEXT NOT NULL,            -- OPERATOR | RESPONDER | MANAGER
  kakao_id        TEXT,                     -- reserved for real Kakao provider
  active          INTEGER NOT NULL DEFAULT 1
);

-- Current state of each ANDON. History lives in andon_transition.
CREATE TABLE IF NOT EXISTS andon_event (
  id                TEXT PRIMARY KEY,       -- e.g. AND-20261001-003
  plant             TEXT NOT NULL,
  line_code         TEXT NOT NULL REFERENCES line(code),
  process_id        INTEGER NOT NULL REFERENCES process(id),
  category_code     TEXT NOT NULL REFERENCES category(code),
  department_code   TEXT NOT NULL REFERENCES department(code),
  description       TEXT NOT NULL,
  photo_file        TEXT,
  status            TEXT NOT NULL CHECK (status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','CLOSED')),
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  acknowledged_at   TEXT,
  acknowledged_by   TEXT,
  closed_at         TEXT,
  closed_by         TEXT,
  corrective_action TEXT,
  updated_at        TEXT NOT NULL,
  client_request_id TEXT UNIQUE             -- idempotency key: prevents duplicate submissions
);
CREATE INDEX IF NOT EXISTS idx_event_status ON andon_event(status);
CREATE INDEX IF NOT EXISTS idx_event_created ON andon_event(created_at);

-- Append-only history. Triggers below forbid UPDATE / DELETE.
CREATE TABLE IF NOT EXISTS andon_transition (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL REFERENCES andon_event(id),
  action      TEXT NOT NULL,                -- CREATE | ACKNOWLEDGE | ACTION | CLOSE
  from_status TEXT,
  to_status   TEXT NOT NULL,
  user_name   TEXT NOT NULL,
  comment     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transition_event ON andon_transition(event_id);

CREATE TRIGGER IF NOT EXISTS trg_transition_no_update BEFORE UPDATE ON andon_transition
BEGIN SELECT RAISE(ABORT, 'andon_transition is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_transition_no_delete BEFORE DELETE ON andon_transition
BEGIN SELECT RAISE(ABORT, 'andon_transition is append-only'); END;

-- Every notification attempt (success or failure).
CREATE TABLE IF NOT EXISTS notification_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL REFERENCES andon_event(id),
  provider    TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  status      TEXT NOT NULL,                -- SENT | FAILED
  message     TEXT NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_event ON notification_log(event_id);
`;

function seedMasterData(db: DatabaseSync) {
  const dep = db.prepare("INSERT OR IGNORE INTO department (code, name_ko, name_en) VALUES (?, ?, ?)");
  for (const d of DEPARTMENTS) dep.run(d.code, d.nameKo, d.nameEn);

  const cat = db.prepare(
    "INSERT OR IGNORE INTO category (code, name_ko, name_en, default_department, sort_order) VALUES (?, ?, ?, ?, ?)",
  );
  for (const c of CATEGORIES) cat.run(c.code, c.nameKo, c.nameEn, c.defaultDepartment, c.sortOrder);

  const line = db.prepare("INSERT OR IGNORE INTO line (code, name, sort_order) VALUES (?, ?, ?)");
  for (const l of LINES) line.run(l.code, l.name, l.sortOrder);

  const proc = db.prepare("INSERT OR IGNORE INTO process (line_code, name, sort_order) VALUES (?, ?, ?)");
  for (const p of PROCESSES) proc.run(p.lineCode, p.name, p.sortOrder);

  const user = db.prepare("INSERT OR IGNORE INTO app_user (name, department_code, role) VALUES (?, ?, ?)");
  for (const u of USERS) user.run(u.name, u.departmentCode, u.role);
}

function openDatabase(): DatabaseSync {
  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const db = new DatabaseSync(DATABASE_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;"); // durability over speed: ANDON write volume is tiny
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  transaction(db, () => seedMasterData(db));
  return db;
}

// Keep a single connection across Next.js dev hot-reloads.
const globalForDb = globalThis as unknown as { __andonDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (!globalForDb.__andonDb) {
    globalForDb.__andonDb = openDatabase();
    console.info(`[db] opened ${DATABASE_PATH}`);
  }
  return globalForDb.__andonDb;
}

/** Run fn inside BEGIN IMMEDIATE / COMMIT; rolls back on any thrown error. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
