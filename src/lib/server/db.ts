// Database access. Two backends behind one async API (see sql.ts):
//   - TURSO_DATABASE_URL set → Turso / libSQL (Vercel). Schema is migrated ONLY by `npm run db:migrate`;
//     a request never migrates or seeds a remote database (serverless instances start concurrently).
//   - otherwise → SQLite file DATABASE_PATH via node:sqlite (local PC / plant server). Migrated + master
//     data seeded on first use, with a backup before every migration. Backup = copy the file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  CATEGORIES,
  DEPARTMENTS,
  ESCALATION_POLICIES,
  ESCALATION_STEPS,
  LEGACY_DEPARTMENT_SUCCESSORS,
  LINES,
  PLANTS,
  PROCESSES,
  ROLES,
  ROUTING_RULES,
  USERS,
} from "./masterData.ts";
import { FileDriver, RemoteDriver, type Driver, type Param, type Sql } from "./sql.ts";

export const DATABASE_PATH = path.resolve(/*turbopackIgnore: true*/ process.env.DATABASE_PATH || "./data/andon.db");
export const UPLOAD_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR || "./data/uploads");
/** Turso / libSQL URL (set by the Vercel Marketplace integration). Empty = local SQLite file. */
export const REMOTE_DATABASE_URL = (process.env.TURSO_DATABASE_URL || "").trim();

// ---------------------------------------------------------------- schema migrations
//
// Applied schema version: PRAGMA user_version on a SQLite file; on Turso (which rejects writes to
// user_version) the single row of table schema_meta. Each migration runs once, in its own transaction,
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
async function migrateV2(db: Sql) {
  await db.exec(`
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
  await seedPlantsAndRoles(db);

  await db.exec(`
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

/**
 * v3 — Milestone 2B: departments ME / MT / UAP / QC / PCL, user registration & sessions.
 *  - department.display_code / sort_order / successor_code. Old departments (QUALITY, …) stay as
 *    INACTIVE rows with successor_code → historical events keep their original department code.
 *  - Master data (users, category defaults, routing rules, escalation scope) moves to the new codes.
 *  - app_user rebuilt: name no longer unique (people share names), email (unique, normalized),
 *    created_at, source. Ids are preserved, so history user_id references stay valid.
 *  - user_identity (auth provider + subject + password hash; LOCAL now, GOOGLE/KAKAO later),
 *    user_session (hashed session tokens), user_notification_channel (prepared, unused).
 *  - andon_transition.user_department / user_role: snapshot of the actor at the time of the action.
 * Never touches andon_event / andon_transition / notification_log rows.
 */
async function migrateV3(db: Sql) {
  await db.exec(`
    ALTER TABLE department ADD COLUMN display_code TEXT;
    ALTER TABLE department ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE department ADD COLUMN successor_code TEXT REFERENCES department(code);
  `);
  for (const d of DEPARTMENTS) {
    await db.run(
      `INSERT INTO department (code, name_ko, name_en, display_code, sort_order, active) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(code) DO UPDATE SET display_code = excluded.display_code, sort_order = excluded.sort_order, active = 1`,
      d.code, d.nameKo, d.nameEn, d.displayCode, d.sortOrder,
    );
  }

  // Legacy departments: keep the rows (history refers to them), deactivate, point to the successor.
  const remap = (table: string, column: string, from: string, to: string) =>
    db.run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, to, from);
  for (const [oldCode, newCode] of Object.entries(LEGACY_DEPARTMENT_SUCCESSORS)) {
    await db.run(
      "UPDATE department SET active = 0, successor_code = ?, display_code = COALESCE(display_code, code), sort_order = 100 WHERE code = ?",
      newCode, oldCode,
    );
    // Configuration only (not history):
    await remap("category", "default_department", oldCode, newCode);
    await remap("routing_rule", "department_code", oldCode, newCode);
    await remap("escalation_policy", "department_code", oldCode, newCode);
  }

  await db.exec(`
    CREATE TABLE app_user_v3 (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      email           TEXT,                    -- normalized (trim + lowercase); NULL for accounts without login
      department_code TEXT NOT NULL REFERENCES department(code),
      role            TEXT NOT NULL REFERENCES role(code),
      kakao_id        TEXT,                    -- legacy placeholder; see user_notification_channel
      active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      source          TEXT NOT NULL DEFAULT 'SEED' CHECK (source IN ('SEED', 'REGISTRATION', 'ADMIN')),
      created_at      TEXT
    );
  `);
  const successors = JSON.stringify(LEGACY_DEPARTMENT_SUCCESSORS);
  await db.run(
    `INSERT INTO app_user_v3 (id, name, email, department_code, role, kakao_id, active, source, created_at)
     SELECT id, name, NULL, COALESCE(json_extract(?, '$."' || department_code || '"'), department_code),
            role, kakao_id, active, 'SEED', NULL
     FROM app_user`,
    successors,
  );
  await db.exec(`
    DROP TABLE app_user;
    ALTER TABLE app_user_v3 RENAME TO app_user;
    CREATE UNIQUE INDEX ux_app_user_email ON app_user(email) WHERE email IS NOT NULL;
    CREATE INDEX ix_app_user_department ON app_user(department_code, active);

    -- Authentication identities: how a person proves who they are. One user may later have several
    -- (LOCAL password now; GOOGLE / KAKAO login later). Routing never looks at this table.
    CREATE TABLE user_identity (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES app_user(id),
      provider      TEXT NOT NULL CHECK (provider IN ('LOCAL', 'GOOGLE', 'KAKAO')),
      subject       TEXT NOT NULL,           -- LOCAL: normalized email; GOOGLE/KAKAO: provider user id
      password_hash TEXT,                    -- LOCAL only: scrypt$N$r$p$salt$hash — never sent to clients
      created_at    TEXT NOT NULL,
      last_login_at TEXT,
      UNIQUE (provider, subject)
    );
    CREATE INDEX ix_user_identity_user ON user_identity(user_id);

    -- Server-side sessions. Only a SHA-256 hash of the cookie token is stored.
    CREATE TABLE user_session (
      token_hash   TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES app_user(id),
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at   TEXT,
      device_id    TEXT,
      client_ip    TEXT,
      user_agent   TEXT
    );
    CREATE INDEX ix_user_session_user ON user_session(user_id);

    -- Notification identities (PREPARED, NOT USED): where a person receives messages. Separate from
    -- authentication: a Google login e-mail is never assumed to be a KakaoTalk recipient.
    CREATE TABLE user_notification_channel (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES app_user(id),
      provider     TEXT NOT NULL CHECK (provider IN ('KAKAO', 'SMS', 'EMAIL')),
      recipient_id TEXT NOT NULL,
      verified     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
      active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      created_at   TEXT NOT NULL,
      UNIQUE (provider, recipient_id)
    );

    ALTER TABLE andon_transition ADD COLUMN user_department TEXT;
    ALTER TABLE andon_transition ADD COLUMN user_role TEXT;
  `);
}

/** v4: additive employee/contact fields and short-lived Google login transactions. */
async function migrateV4(db: Sql) {
  await db.exec(`
    ALTER TABLE app_user ADD COLUMN employee_id TEXT;
    ALTER TABLE app_user ADD COLUMN phone TEXT;
    ALTER TABLE app_user ADD COLUMN company_email TEXT;
    CREATE UNIQUE INDEX ux_employee_id ON app_user(employee_id) WHERE employee_id IS NOT NULL;
    CREATE TRIGGER employee_id_immutable BEFORE UPDATE OF employee_id ON app_user
      WHEN OLD.employee_id IS NOT NULL AND NEW.employee_id IS NOT OLD.employee_id
      BEGIN SELECT RAISE(ABORT, 'employee_id is permanent'); END;
    ALTER TABLE user_identity ADD COLUMN provider_email TEXT;
    CREATE UNIQUE INDEX ux_google_user ON user_identity(user_id) WHERE provider = 'GOOGLE';
    CREATE TABLE google_auth_flow (
      token_hash TEXT PRIMARY KEY,
      phase TEXT NOT NULL CHECK(phase IN ('AUTHORIZATION','ONBOARDING')),
      state TEXT, nonce TEXT, verifier TEXT,
      next_path TEXT NOT NULL,
      link_user_id INTEGER REFERENCES app_user(id),
      link_session_hash TEXT,
      subject TEXT, provider_email TEXT, display_name TEXT,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX ix_google_flow_expiry ON google_auth_flow(expires_at);
  `);
}

/**
 * v5 — Vercel / serverless: login throttling must be shared by all server instances, so the failure
 * counter moves from process memory into the database. Key = SHA-256 of "e-mail|IP" (no plain e-mail).
 */
async function migrateV5(db: Sql) {
  await db.exec(`
    CREATE TABLE login_throttle (
      throttle_key     TEXT PRIMARY KEY,
      failures         INTEGER NOT NULL,
      first_failure_at TEXT NOT NULL
    );
  `);
}

const MIGRATIONS: { version: number; up: (db: Sql) => Promise<void>; foreignKeysOff?: boolean }[] = [
  { version: 1, up: (db) => db.exec(V1_SQL) },
  { version: 2, up: migrateV2 },
  // Rebuilds app_user, which andon_transition references → FKs off during the rebuild, checked after.
  { version: 3, up: migrateV3, foreignKeysOff: true },
  { version: 4, up: migrateV4 },
  { version: 5, up: migrateV5 },
];
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

const SCHEMA_META_SQL = "CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)";

export async function schemaVersion(d: Driver): Promise<number> {
  if (d.kind === "file") return Number((await d.get("PRAGMA user_version"))?.user_version ?? 0);
  const t = await d.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'");
  if (!t) return 0;
  return Number((await d.get("SELECT version FROM schema_meta WHERE id = 1"))?.version ?? 0);
}

async function setSchemaVersion(d: Driver, version: number) {
  if (d.kind === "file") {
    await d.exec(`PRAGMA user_version = ${version}`);
    return;
  }
  await d.exec(SCHEMA_META_SQL);
  await d.run("INSERT INTO schema_meta (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version", version);
}

function backupBeforeMigration(conn: DatabaseSync, from: number) {
  const dir = path.join(path.dirname(DATABASE_PATH), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `andon-pre-migration-v${from}-to-v${SCHEMA_VERSION}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  // VACUUM INTO a short temp path first (SQLite on Windows fails on paths > 260 chars), then copy.
  const tmp = path.join(os.tmpdir(), `andon-premigration-${process.pid}.db`);
  fs.rmSync(tmp, { force: true });
  conn.prepare("VACUUM INTO ?").run(tmp);
  fs.copyFileSync(tmp, target);
  fs.rmSync(tmp, { force: true });
  console.info(`[db] backup before migration: ${target}`);
}

/**
 * Applies pending migrations in order, each in its own transaction, then verifies foreign keys.
 * File databases are backed up first. A remote database (Turso) cannot switch foreign keys off, so a
 * migration that needs it (v3) can only run on a remote database that is still empty (fresh install).
 */
export async function migrate(d: Driver, conn?: DatabaseSync): Promise<void> {
  const current = await schemaVersion(d);
  if (current > SCHEMA_VERSION) {
    throw new Error(`Database schema v${current} is newer than this application (v${SCHEMA_VERSION}). Update the application; do not downgrade.`);
  }
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;
  if (d.kind === "remote" && current > 0 && pending.some((m) => m.foreignKeysOff)) {
    throw new Error("This migration rebuilds a referenced table and must run on a SQLite file copy, not on Turso.");
  }
  if (current > 0 && conn) backupBeforeMigration(conn, current);
  for (const m of pending) {
    await d.transaction(
      async () => {
        await m.up(d);
        const fk = await d.all("PRAGMA foreign_key_check");
        if (fk.length) throw new Error(`foreign key violations in migration v${m.version}: ${JSON.stringify(fk.slice(0, 5))}`);
        await setSchemaVersion(d, m.version);
      },
      { foreignKeysOff: m.foreignKeysOff },
    );
    console.info(`[db] migrated schema to v${m.version}`);
  }
  const fk = await d.all("PRAGMA foreign_key_check");
  if (fk.length) throw new Error(`foreign key violations after migration: ${JSON.stringify(fk.slice(0, 5))}`);
}

// ---------------------------------------------------------------- master data bootstrap

async function seedPlantsAndRoles(db: Sql) {
  for (const p of PLANTS) await db.run("INSERT OR IGNORE INTO plant (code, name, name_ko) VALUES (?, ?, ?)", p.code, p.name, p.nameKo);
  for (const r of ROLES) {
    await db.run(
      "INSERT OR IGNORE INTO role (code, name_ko, name_en, can_respond, escalation_level, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      r.code, r.nameKo, r.nameEn, r.canRespond ? 1 : 0, r.escalationLevel, r.sortOrder,
    );
  }
}

/** Inserts missing master data only — edits made in the DB are never overwritten. */
export async function seedMasterData(db: Sql): Promise<void> {
  await seedPlantsAndRoles(db);
  for (const d of DEPARTMENTS) {
    await db.run(
      "INSERT OR IGNORE INTO department (code, name_ko, name_en, display_code, sort_order) VALUES (?, ?, ?, ?, ?)",
      d.code, d.nameKo, d.nameEn, d.displayCode, d.sortOrder,
    );
  }
  for (const c of CATEGORIES) {
    await db.run(
      "INSERT OR IGNORE INTO category (code, name_ko, name_en, default_department, sort_order) VALUES (?, ?, ?, ?, ?)",
      c.code, c.nameKo, c.nameEn, c.defaultDepartment, c.sortOrder,
    );
  }
  for (const l of LINES) {
    await db.run("INSERT OR IGNORE INTO line (code, name, sort_order, plant_code) VALUES (?, ?, ?, ?)", l.code, l.name, l.sortOrder, l.plantCode);
  }
  // AUTOINCREMENT tables: "INSERT ... WHERE NOT EXISTS" instead of INSERT OR IGNORE, which would
  // consume an id from the sequence on every start-up even when the row already exists.
  for (const p of PROCESSES) {
    await db.run(
      `INSERT INTO process (line_code, name, sort_order) SELECT ?1, ?2, ?3
       WHERE NOT EXISTS (SELECT 1 FROM process WHERE line_code = ?1 AND name = ?2)`,
      p.lineCode, p.name, p.sortOrder,
    );
  }
  for (const u of USERS) {
    await db.run(
      `INSERT INTO app_user (name, department_code, role, active) SELECT ?1, ?2, ?3, ?4
       WHERE NOT EXISTS (SELECT 1 FROM app_user WHERE name = ?1)`,
      u.name, u.departmentCode, u.role, u.active ? 1 : 0,
    );
  }
  for (const r of ROUTING_RULES) {
    const pid = r.processName
      ? ((await db.get("SELECT id FROM process WHERE line_code = ? AND name = ?", r.lineCode, r.processName))?.id as number | undefined)
      : null;
    if (r.processName && pid == null) continue;
    await db.run(
      `INSERT INTO routing_rule (category_code, line_code, process_id, department_code, note, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE NOT EXISTS (SELECT 1 FROM routing_rule WHERE category_code = ?1 AND line_code = ?2 AND IFNULL(process_id, 0) = IFNULL(?3, 0))`,
      r.categoryCode, r.lineCode, pid ?? null, r.departmentCode, r.note, nowIso(),
    );
  }
  for (const p of ESCALATION_POLICIES) {
    await db.run("INSERT OR IGNORE INTO escalation_policy (code, name, active) VALUES (?, ?, 0)", p.code, p.name);
  }
  for (const st of ESCALATION_STEPS) {
    await db.run(
      `INSERT INTO escalation_step (policy_code, step_no, target_role, after_minutes, active) SELECT ?1, ?2, ?3, NULL, 0
       WHERE NOT EXISTS (SELECT 1 FROM escalation_step WHERE policy_code = ?1 AND step_no = ?2 AND target_role = ?3)`,
      st.policyCode, st.stepNo, st.targetRole,
    );
  }
}

// ---------------------------------------------------------------- connection

/** Opens the configured database. `maintenance` = called by the migrate script (remote may be migrated). */
export async function openDatabase(opts: { maintenance?: boolean } = {}): Promise<Driver> {
  if (REMOTE_DATABASE_URL) {
    const { createClient } = await import("@libsql/client/web");
    const client = createClient({ url: REMOTE_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
    const label = `turso ${new URL(REMOTE_DATABASE_URL).host}`;
    const d = new RemoteDriver(client, label);
    if (!opts.maintenance) {
      const v = await schemaVersion(d);
      if (v !== SCHEMA_VERSION) {
        d.close();
        throw new Error(`Remote database is at schema v${v}, the application needs v${SCHEMA_VERSION}. Run "npm run db:migrate" with the Turso credentials.`);
      }
    }
    return d;
  }

  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const conn = new DatabaseSync(DATABASE_PATH);
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA synchronous = FULL;"); // durability over speed: ANDON write volume is tiny
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec("PRAGMA busy_timeout = 5000;");
  const d = new FileDriver(conn, DATABASE_PATH);
  if (!opts.maintenance) {
    await migrate(d, conn);
    await d.transaction(() => seedMasterData(d));
  }
  return d;
}

// One connection per process, shared across Next.js dev hot-reloads.
const globalForDb = globalThis as unknown as { __andonDb?: Promise<Driver> };

function ready(): Promise<Driver> {
  globalForDb.__andonDb ??= openDatabase().then(
    (d) => {
      console.info(`[db] opened ${d.label}`);
      return d;
    },
    (err) => {
      globalForDb.__andonDb = undefined; // retry on the next request
      throw err;
    },
  );
  return globalForDb.__andonDb;
}

/** The application database. Every call is async; queries inside db.transaction() join the transaction. */
export const db = {
  all: async (sql: string, ...p: Param[]) => (await ready()).all(sql, ...p),
  get: async (sql: string, ...p: Param[]) => (await ready()).get(sql, ...p),
  run: async (sql: string, ...p: Param[]) => (await ready()).run(sql, ...p),
  exec: async (sql: string) => (await ready()).exec(sql),
  transaction: async <T>(fn: () => Promise<T>) => (await ready()).transaction(fn),
  info: async () => {
    const d = await ready();
    return { kind: d.kind, label: d.label };
  },
};

export function nowIso(): string {
  return new Date().toISOString();
}
