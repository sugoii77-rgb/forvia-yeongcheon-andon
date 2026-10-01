// SQLite access via Node's built-in `node:sqlite` (Node >= 22.13; project uses Node 24).
// One file = the whole database. Backup = copy the file (or use `npm run backup`).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CATEGORIES,
  DEPARTMENTS,
  ESCALATION_POLICIES,
  ESCALATION_STEPS,
  LINES,
  PLANTS,
  PROCESSES,
  ROLES,
  ROUTING_RULES,
  USERS,
} from "./masterData.ts";

export const DATABASE_PATH = path.resolve(/*turbopackIgnore: true*/ process.env.DATABASE_PATH || "./data/andon.db");
export const UPLOAD_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR || "./data/uploads");

// ---------------------------------------------------------------- schema migrations
//
// PRAGMA user_version = applied schema version. Each migration runs once, in its own transaction,
// in order. NEVER edit a released migration — add a new one. An existing database is backed up to
// data/backups/ before it is migrated.

/** v1 — Milestone 1 schema (unchanged; IF NOT EXISTS so it also matches databases created by M1). */
const V1_SQL = `
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

/**
 * v2 — Milestone 2A: responsibility & routing foundation.
 *  - plant, role tables; line.plant_code
 *  - app_user rebuilt with FK role → role(code), active flag checked (MANAGER → SUPERVISOR)
 *  - routing_rule (category + line [+ process] → department), most specific wins
 *  - andon_event.routing_rule_id (why this department), escalation_level (prepared, unused)
 *  - andon_transition.user_id / device_id / client_ip / user_agent (audit; older rows stay NULL)
 *  - escalation_policy / escalation_step (prepared, inactive, thresholds NULL)
 */
function migrateV2(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE plant (
      code    TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      name_ko TEXT NOT NULL,
      active  INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );
    CREATE TABLE role (
      code             TEXT PRIMARY KEY,
      name_ko          TEXT NOT NULL,
      name_en          TEXT NOT NULL,
      can_respond      INTEGER NOT NULL DEFAULT 0 CHECK (can_respond IN (0, 1)),
      escalation_level INTEGER,            -- prepared for escalation; NULL = not an escalation target
      sort_order       INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Plants and roles must exist before the foreign keys below can be satisfied.
  seedPlantsAndRoles(db);

  db.exec(`
    ALTER TABLE line ADD COLUMN plant_code TEXT REFERENCES plant(code);
    UPDATE line SET plant_code = '${PLANTS[0].code}' WHERE plant_code IS NULL;

    CREATE TABLE app_user_v2 (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL UNIQUE,
      department_code TEXT NOT NULL REFERENCES department(code),
      role            TEXT NOT NULL REFERENCES role(code),
      kakao_id        TEXT,                -- reserved for the Kakao provider
      active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );
    INSERT INTO app_user_v2 (id, name, department_code, role, kakao_id, active)
      SELECT id, name, department_code,
             CASE role WHEN 'MANAGER' THEN 'SUPERVISOR' ELSE role END,
             kakao_id, active
      FROM app_user;
    DROP TABLE app_user;
    ALTER TABLE app_user_v2 RENAME TO app_user;

    CREATE TABLE routing_rule (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      category_code   TEXT NOT NULL REFERENCES category(code),
      line_code       TEXT NOT NULL REFERENCES line(code),
      process_id      INTEGER REFERENCES process(id),   -- NULL = whole line
      department_code TEXT NOT NULL REFERENCES department(code),
      active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      note            TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE UNIQUE INDEX ux_routing_rule ON routing_rule(category_code, line_code, IFNULL(process_id, 0));
    CREATE TRIGGER trg_routing_rule_process_line_ins BEFORE INSERT ON routing_rule
    WHEN NEW.process_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM process WHERE id = NEW.process_id AND line_code = NEW.line_code)
    BEGIN SELECT RAISE(ABORT, 'routing_rule: process does not belong to line'); END;
    CREATE TRIGGER trg_routing_rule_process_line_upd BEFORE UPDATE ON routing_rule
    WHEN NEW.process_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM process WHERE id = NEW.process_id AND line_code = NEW.line_code)
    BEGIN SELECT RAISE(ABORT, 'routing_rule: process does not belong to line'); END;

    ALTER TABLE andon_event ADD COLUMN routing_rule_id INTEGER REFERENCES routing_rule(id);
    ALTER TABLE andon_event ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE andon_transition ADD COLUMN user_id INTEGER REFERENCES app_user(id);
    ALTER TABLE andon_transition ADD COLUMN device_id TEXT;
    ALTER TABLE andon_transition ADD COLUMN client_ip TEXT;
    ALTER TABLE andon_transition ADD COLUMN user_agent TEXT;

    CREATE TABLE escalation_policy (
      code            TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      department_code TEXT REFERENCES department(code),   -- NULL = all departments
      category_code   TEXT REFERENCES category(code),     -- NULL = all categories
      active          INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
    );
    CREATE TABLE escalation_step (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_code   TEXT NOT NULL REFERENCES escalation_policy(code),
      step_no       INTEGER NOT NULL CHECK (step_no >= 1),
      target_role   TEXT NOT NULL REFERENCES role(code),
      after_minutes INTEGER CHECK (after_minutes IS NULL OR after_minutes > 0), -- NULL = not configured
      active        INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      UNIQUE (policy_code, step_no, target_role)
    );
  `);
}

const MIGRATIONS: { version: number; up: (db: DatabaseSync) => void }[] = [
  { version: 1, up: (db) => db.exec(V1_SQL) },
  { version: 2, up: migrateV2 },
];
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function backupBeforeMigration(db: DatabaseSync, from: number) {
  const dir = path.join(path.dirname(DATABASE_PATH), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `andon-pre-migration-v${from}-to-v${SCHEMA_VERSION}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  // VACUUM INTO a short temp path first (SQLite on Windows fails on paths > 260 chars), then copy.
  const tmp = path.join(os.tmpdir(), `andon-premigration-${process.pid}.db`);
  fs.rmSync(tmp, { force: true });
  db.prepare("VACUUM INTO ?").run(tmp);
  fs.copyFileSync(tmp, target);
  fs.rmSync(tmp, { force: true });
  console.info(`[db] backup before migration: ${target}`);
}

function migrate(db: DatabaseSync) {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema v${current} is newer than this application (v${SCHEMA_VERSION}). Update the application; do not downgrade.`,
    );
  }
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;
  if (current > 0) backupBeforeMigration(db, current);
  for (const m of pending) {
    transaction(db, () => {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
    console.info(`[db] migrated schema to v${m.version}`);
  }
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  if (fk.length) throw new Error(`foreign key violations after migration: ${JSON.stringify(fk.slice(0, 5))}`);
}

// ---------------------------------------------------------------- master data bootstrap

function seedPlantsAndRoles(db: DatabaseSync) {
  const plant = db.prepare("INSERT OR IGNORE INTO plant (code, name, name_ko) VALUES (?, ?, ?)");
  for (const p of PLANTS) plant.run(p.code, p.name, p.nameKo);
  const role = db.prepare(
    "INSERT OR IGNORE INTO role (code, name_ko, name_en, can_respond, escalation_level, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const r of ROLES) role.run(r.code, r.nameKo, r.nameEn, r.canRespond ? 1 : 0, r.escalationLevel, r.sortOrder);
}

function seedMasterData(db: DatabaseSync) {
  seedPlantsAndRoles(db);

  const dep = db.prepare("INSERT OR IGNORE INTO department (code, name_ko, name_en) VALUES (?, ?, ?)");
  for (const d of DEPARTMENTS) dep.run(d.code, d.nameKo, d.nameEn);

  const cat = db.prepare(
    "INSERT OR IGNORE INTO category (code, name_ko, name_en, default_department, sort_order) VALUES (?, ?, ?, ?, ?)",
  );
  for (const c of CATEGORIES) cat.run(c.code, c.nameKo, c.nameEn, c.defaultDepartment, c.sortOrder);

  const line = db.prepare("INSERT OR IGNORE INTO line (code, name, sort_order, plant_code) VALUES (?, ?, ?, ?)");
  for (const l of LINES) line.run(l.code, l.name, l.sortOrder, l.plantCode);

  // AUTOINCREMENT tables: "INSERT ... WHERE NOT EXISTS" instead of INSERT OR IGNORE, which would
  // consume an id from the sequence on every start-up even when the row already exists.
  const proc = db.prepare(
    `INSERT INTO process (line_code, name, sort_order) SELECT ?1, ?2, ?3
     WHERE NOT EXISTS (SELECT 1 FROM process WHERE line_code = ?1 AND name = ?2)`,
  );
  for (const p of PROCESSES) proc.run(p.lineCode, p.name, p.sortOrder);

  const user = db.prepare(
    `INSERT INTO app_user (name, department_code, role, active) SELECT ?1, ?2, ?3, ?4
     WHERE NOT EXISTS (SELECT 1 FROM app_user WHERE name = ?1)`,
  );
  for (const u of USERS) user.run(u.name, u.departmentCode, u.role, u.active ? 1 : 0);

  const procId = db.prepare("SELECT id FROM process WHERE line_code = ? AND name = ?");
  const rule = db.prepare(
    `INSERT INTO routing_rule (category_code, line_code, process_id, department_code, note, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
     WHERE NOT EXISTS (SELECT 1 FROM routing_rule WHERE category_code = ?1 AND line_code = ?2 AND IFNULL(process_id, 0) = IFNULL(?3, 0))`,
  );
  for (const r of ROUTING_RULES) {
    const pid = r.processName ? (procId.get(r.lineCode, r.processName) as { id: number } | undefined)?.id : null;
    if (r.processName && pid == null) continue;
    rule.run(r.categoryCode, r.lineCode, pid ?? null, r.departmentCode, r.note, nowIso());
  }

  const pol = db.prepare("INSERT OR IGNORE INTO escalation_policy (code, name, active) VALUES (?, ?, 0)");
  for (const p of ESCALATION_POLICIES) pol.run(p.code, p.name);
  const step = db.prepare(
    `INSERT INTO escalation_step (policy_code, step_no, target_role, after_minutes, active) SELECT ?1, ?2, ?3, NULL, 0
     WHERE NOT EXISTS (SELECT 1 FROM escalation_step WHERE policy_code = ?1 AND step_no = ?2 AND target_role = ?3)`,
  );
  for (const s of ESCALATION_STEPS) step.run(s.policyCode, s.stepNo, s.targetRole);
}

function openDatabase(): DatabaseSync {
  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const db = new DatabaseSync(DATABASE_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;"); // durability over speed: ANDON write volume is tiny
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  migrate(db);
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
