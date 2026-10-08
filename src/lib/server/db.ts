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
  PLACEHOLDER_PROCESS_NAME,
  PLANTS,
  PROCESSES,
  ROLES,
  ROUTING_RULES,
  SHIFTS,
  SHIFT_SCHEDULES,
  UAP_AREAS,
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

/**
 * v6 — Yeongcheon line master + UAP line ownership (Supervisor / GAP leader by shift).
 *  - uap_area (AP-1 … RESO); line.uap_area_code (NULL = prototype line without an area)
 *  - process.placeholder: 1 = "공정 미지정" stand-in while the real process master is missing
 *  - shift (A, B): start_time / end_time NULL until the plant confirms the clock times
 *  - app_user.import_key: stable key of an employee created by the workbook import (no duplicates
 *    when one person covers several lines or the import is repeated)
 *  - line_assignment: line → employee as SUPERVISOR (no shift) or GAP_LEADER (shift A / B), with
 *    effective_from / effective_to + active. Ownership (actor), NOT the responsible department —
 *    routing_rule / category decide the department, unchanged.
 * Additive only (new tables, nullable / defaulted columns): no existing row changes.
 */
async function migrateV6(db: Sql) {
  await db.exec(`
    CREATE TABLE uap_area (
      code       TEXT PRIMARY KEY,
      plant_code TEXT NOT NULL REFERENCES plant(code),
      name       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );
    ALTER TABLE line ADD COLUMN uap_area_code TEXT REFERENCES uap_area(code);
    ALTER TABLE process ADD COLUMN placeholder INTEGER NOT NULL DEFAULT 0 CHECK (placeholder IN (0, 1));
    CREATE TABLE shift (
      code       TEXT PRIMARY KEY,
      name_ko    TEXT NOT NULL,
      start_time TEXT,                       -- 'HH:MM' local time; NULL = not confirmed by the plant
      end_time   TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );
    ALTER TABLE app_user ADD COLUMN import_key TEXT;
    CREATE UNIQUE INDEX idx_app_user_import_key ON app_user(import_key) WHERE import_key IS NOT NULL;
    CREATE TABLE line_assignment (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      line_code       TEXT NOT NULL REFERENCES line(code),
      user_id         INTEGER NOT NULL REFERENCES app_user(id),
      assignment_role TEXT NOT NULL CHECK (assignment_role IN ('SUPERVISOR', 'GAP_LEADER')),
      shift_code      TEXT REFERENCES shift(code),
      effective_from  TEXT NOT NULL,
      effective_to    TEXT,                  -- NULL = open-ended
      active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      source          TEXT NOT NULL CHECK (source IN ('WORKBOOK', 'ADMIN')),
      source_ref      TEXT,                  -- e.g. workbook file name
      created_at      TEXT NOT NULL,
      CHECK ((assignment_role = 'SUPERVISOR' AND shift_code IS NULL) OR (assignment_role = 'GAP_LEADER' AND shift_code IS NOT NULL)),
      CHECK (effective_to IS NULL OR effective_to >= effective_from)
    );
    -- at most one ACTIVE supervisor per line and one ACTIVE GAP leader per line and shift
    CREATE UNIQUE INDEX idx_line_assignment_current ON line_assignment(line_code, assignment_role, IFNULL(shift_code, '-')) WHERE active = 1;
    CREATE INDEX idx_line_assignment_user ON line_assignment(user_id);
  `);
}

/**
 * v7 — A/B shift schedule (confirmed rule: 12 h shifts 08:00 / 20:00 Asia/Seoul, weekly A/B swap at the
 * Monday 08:00 DAY shift) + shift context snapshot on NEW ANDON events.
 *  - shift_schedule: one row per plant with the rule and the ANCHOR (week Monday + DAY team). Anchor NULL =
 *    not configured → automatic A/B determination is unavailable (SHIFT_SCHEDULE_NOT_ANCHORED)
 *  - shift_schedule_audit: append-only log of anchor changes (who, when, old, new)
 *  - andon_event.shift_*: snapshot at creation. NULL on events created before v7 (never back-filled);
 *    shift_status UNRESOLVED + reason when the shift could not be resolved — the ANDON is created anyway.
 * Additive only.
 */
async function migrateV7(db: Sql) {
  await db.exec(`
    CREATE TABLE shift_schedule (
      plant_code         TEXT PRIMARY KEY REFERENCES plant(code),
      time_zone          TEXT NOT NULL,
      day_start          TEXT NOT NULL,          -- 'HH:MM' DAY shift start (inclusive)
      night_start        TEXT NOT NULL,          -- 'HH:MM' NIGHT shift start (inclusive)
      rotation_weekday   TEXT NOT NULL,          -- weekly A/B swap at this weekday's DAY shift start
      anchor_week_monday TEXT,                   -- YYYY-MM-DD; NULL = not configured
      anchor_day_team    TEXT REFERENCES shift(code),
      updated_at         TEXT,
      updated_by_user_id INTEGER REFERENCES app_user(id),
      updated_by         TEXT,
      CHECK ((anchor_week_monday IS NULL AND anchor_day_team IS NULL) OR (anchor_week_monday IS NOT NULL AND anchor_day_team IS NOT NULL))
    );
    CREATE TABLE shift_schedule_audit (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_code             TEXT NOT NULL REFERENCES plant(code),
      changed_at             TEXT NOT NULL,
      changed_by_user_id     INTEGER REFERENCES app_user(id),
      changed_by             TEXT NOT NULL,      -- user name at that time, or 'CLI (administrator)'
      source                 TEXT NOT NULL CHECK (source IN ('WEB', 'CLI')),
      old_anchor_week_monday TEXT,
      old_anchor_day_team    TEXT,
      new_anchor_week_monday TEXT,
      new_anchor_day_team    TEXT,
      client_ip              TEXT,
      user_agent             TEXT
    );
    CREATE TRIGGER trg_shift_audit_no_update BEFORE UPDATE ON shift_schedule_audit
    BEGIN SELECT RAISE(ABORT, 'shift_schedule_audit is append-only'); END;
    CREATE TRIGGER trg_shift_audit_no_delete BEFORE DELETE ON shift_schedule_audit
    BEGIN SELECT RAISE(ABORT, 'shift_schedule_audit is append-only'); END;
    ALTER TABLE andon_event ADD COLUMN shift_status TEXT CHECK (shift_status IN ('RESOLVED', 'UNRESOLVED'));
    ALTER TABLE andon_event ADD COLUMN shift_unresolved_reason TEXT;
    ALTER TABLE andon_event ADD COLUMN shift_team TEXT CHECK (shift_team IN ('A', 'B'));
    ALTER TABLE andon_event ADD COLUMN shift_type TEXT CHECK (shift_type IN ('DAY', 'NIGHT'));
    ALTER TABLE andon_event ADD COLUMN shift_operational_date TEXT;
    ALTER TABLE andon_event ADD COLUMN shift_start_at TEXT;
    ALTER TABLE andon_event ADD COLUMN gap_leader_assignment_id INTEGER REFERENCES line_assignment(id);
    ALTER TABLE andon_event ADD COLUMN supervisor_assignment_id INTEGER REFERENCES line_assignment(id);
  `);
}

/**
 * v8 — KakaoTalk "send to me" notifications (each employee links their own Kakao account once).
 *  - kakao_link: per employee, the Kakao app user id and the OAuth tokens, ENCRYPTED (AES-256-GCM);
 *    one Kakao account per employee and one employee per Kakao account
 *  - kakao_link_flow: short-lived (10 min) one-time OAuth state, bound to the session that started it
 *  The notification address itself stays in user_notification_channel (provider KAKAO, verified only
 *  after a successful confirmation message). Additive only.
 */
async function migrateV8(db: Sql) {
  await db.exec(`
    CREATE TABLE kakao_link (
      user_id            INTEGER PRIMARY KEY REFERENCES app_user(id),
      kakao_user_id      TEXT NOT NULL UNIQUE,
      access_token_enc   TEXT NOT NULL,
      access_expires_at  TEXT NOT NULL,
      refresh_token_enc  TEXT NOT NULL,
      refresh_expires_at TEXT,
      scope              TEXT,
      linked_at          TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      last_sent_at       TEXT,
      last_error         TEXT
    );
    CREATE TABLE kakao_link_flow (
      state_hash   TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES app_user(id),
      session_hash TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL
    );
  `);
}

/**
 * v9 — GAP-leader call (plant decision 2026-10-06): the GAP leader chooses the responsible departments
 * (one or more) and, within each, the people who get the message.
 *  - andon_event_department: departments of an event. andon_event.department_code stays the FIRST one
 *    (board, statistics, older code keep working); events without rows = their department_code only.
 *  - andon_call_recipient: people chosen at the call (messages go to them; no rows = department rule).
 * Both are written once at creation and never changed (append-only triggers). Additive only.
 */
async function migrateV9(db: Sql) {
  await db.exec(`
    CREATE TABLE andon_event_department (
      event_id        TEXT NOT NULL REFERENCES andon_event(id),
      department_code TEXT NOT NULL REFERENCES department(code),
      sort_order      INTEGER NOT NULL,
      PRIMARY KEY (event_id, department_code)
    );
    CREATE TABLE andon_call_recipient (
      event_id        TEXT NOT NULL REFERENCES andon_event(id),
      user_id         INTEGER NOT NULL REFERENCES app_user(id),
      department_code TEXT NOT NULL REFERENCES department(code),
      PRIMARY KEY (event_id, user_id)
    );
    CREATE INDEX idx_event_department_dept ON andon_event_department(department_code);
    ALTER TABLE andon_event ADD COLUMN situations TEXT; -- JSON array of CALL_SITUATIONS codes picked at the call
    -- plant meeting 2026-10-07: team leaders (팀장) get the 2-hour escalation; call_default = always messaged
    -- on calls to QC / MT (UAP 팀장, UAP 책임). Set by the administrator (masterdata / import:accounts).
    ALTER TABLE app_user ADD COLUMN team_leader INTEGER NOT NULL DEFAULT 0 CHECK (team_leader IN (0, 1));
    ALTER TABLE app_user ADD COLUMN call_default INTEGER NOT NULL DEFAULT 0 CHECK (call_default IN (0, 1));
    -- one escalation per event: not completed 2 hours after the call → plant manager + team leaders
    CREATE TABLE andon_escalation (
      event_id     TEXT PRIMARY KEY REFERENCES andon_event(id),
      escalated_at TEXT NOT NULL,
      recipients   INTEGER NOT NULL
    );
    CREATE TRIGGER trg_escalation_no_update BEFORE UPDATE ON andon_escalation
    BEGIN SELECT RAISE(ABORT, 'andon_escalation is append-only'); END;
    CREATE TRIGGER trg_escalation_no_delete BEFORE DELETE ON andon_escalation
    BEGIN SELECT RAISE(ABORT, 'andon_escalation is append-only'); END;
    CREATE TRIGGER trg_event_department_no_update BEFORE UPDATE ON andon_event_department
    BEGIN SELECT RAISE(ABORT, 'andon_event_department is append-only'); END;
    CREATE TRIGGER trg_event_department_no_delete BEFORE DELETE ON andon_event_department
    BEGIN SELECT RAISE(ABORT, 'andon_event_department is append-only'); END;
    CREATE TRIGGER trg_call_recipient_no_update BEFORE UPDATE ON andon_call_recipient
    BEGIN SELECT RAISE(ABORT, 'andon_call_recipient is append-only'); END;
    CREATE TRIGGER trg_call_recipient_no_delete BEFORE DELETE ON andon_call_recipient
    BEGIN SELECT RAISE(ABORT, 'andon_call_recipient is append-only'); END;
  `);
}

/**
 * v10 — self-service password reset (2026-10-08): a 6-digit code is sent to the employee's own KakaoTalk
 * (verified "send to me" link); only its hash is stored, 10 minutes, 5 attempts, one-time.
 */
async function migrateV10(db: Sql) {
  await db.exec(`
    CREATE TABLE password_reset_code (
      user_id    INTEGER PRIMARY KEY REFERENCES app_user(id),
      code_hash  TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
}

/**
 * v11 — phone push notifications (Web Push, 2026-10-08): KakaoTalk "send to me" arrives silently, so each
 * employee can also turn on a push subscription per device (/me). Endpoint + public keys only (no secret
 * of ours); rows are removed when the user turns push off or the push service reports the device gone.
 */
async function migrateV11(db: Sql) {
  await db.exec(`
    CREATE TABLE push_subscription (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES app_user(id),
      endpoint     TEXT NOT NULL UNIQUE,
      p256dh       TEXT NOT NULL,
      auth         TEXT NOT NULL,
      user_agent   TEXT,
      created_at   TEXT NOT NULL,
      last_sent_at TEXT,
      last_error   TEXT
    );
    CREATE INDEX ix_push_subscription_user ON push_subscription(user_id);
  `);
}

const MIGRATIONS: { version: number; up: (db: Sql) => Promise<void>; foreignKeysOff?: boolean }[] = [
  { version: 1, up: (db) => db.exec(V1_SQL) },
  { version: 2, up: migrateV2 },
  // Rebuilds app_user, which andon_transition references → FKs off during the rebuild, checked after.
  { version: 3, up: migrateV3, foreignKeysOff: true },
  { version: 4, up: migrateV4 },
  { version: 5, up: migrateV5 },
  { version: 6, up: migrateV6 },
  { version: 7, up: migrateV7 },
  { version: 8, up: migrateV8 },
  { version: 9, up: migrateV9 },
  { version: 10, up: migrateV10 },
  { version: 11, up: migrateV11 },
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
/** Migrates to the current schema (`target` lower only in tests that need an older schema). */
export async function migrate(d: Driver, conn?: DatabaseSync, target: number = SCHEMA_VERSION): Promise<void> {
  const current = await schemaVersion(d);
  if (current > SCHEMA_VERSION) {
    throw new Error(`Database schema v${current} is newer than this application (v${SCHEMA_VERSION}). Update the application; do not downgrade.`);
  }
  const pending = MIGRATIONS.filter((m) => m.version > current && m.version <= target);
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
  for (const a of UAP_AREAS) {
    await db.run("INSERT OR IGNORE INTO uap_area (code, plant_code, name, sort_order) VALUES (?, 'YC', ?, ?)", a.code, a.name, a.sortOrder);
  }
  for (const l of LINES) {
    await db.run(
      "INSERT OR IGNORE INTO line (code, name, sort_order, plant_code, uap_area_code) VALUES (?, ?, ?, ?, ?)",
      l.code, l.name, l.sortOrder, l.plantCode, l.uapAreaCode ?? null,
    );
  }
  for (const sh of SHIFTS) {
    await db.run("INSERT OR IGNORE INTO shift (code, name_ko, sort_order) VALUES (?, ?, ?)", sh.code, sh.nameKo, sh.sortOrder);
  }
  // Rule only — the anchor is NEVER seeded (it must be configured by an authorized administrator).
  for (const sc of SHIFT_SCHEDULES) {
    await db.run(
      "INSERT OR IGNORE INTO shift_schedule (plant_code, time_zone, day_start, night_start, rotation_weekday) VALUES (?, ?, ?, ?, ?)",
      sc.plantCode, sc.rule.timeZone, sc.rule.dayStart, sc.rule.nightStart, sc.rule.rotationWeekday,
    );
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
  // Real lines have no process master yet → one marked placeholder process each (see masterData.ts).
  for (const l of LINES) {
    if (!l.uapAreaCode) continue;
    await db.run(
      `INSERT INTO process (line_code, name, sort_order, placeholder) SELECT ?1, ?2, 0, 1
       WHERE NOT EXISTS (SELECT 1 FROM process WHERE line_code = ?1)`,
      l.code, PLACEHOLDER_PROCESS_NAME,
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
