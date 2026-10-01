// ANDON business logic. All state changes go through this module.
import {
  ACTIVE_STATUSES,
  TRANSITION_RULES,
  type AndonEvent,
  type AndonStatus,
  type AndonTransition,
  type MasterData,
  type NotificationLogEntry,
  type TransitionAction,
} from "../domain.ts";
import { getDb, nowIso, transaction } from "./db.ts";
import { PLANT } from "./masterData.ts";

/** Error with an HTTP status and a user-facing (Korean) message. */
export class AndonError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Row = Record<string, unknown>;

const EVENT_SELECT = `
SELECT e.*, l.name AS line_name, p.name AS process_name,
       c.name_ko AS category_name, d.name_ko AS department_name
FROM andon_event e
JOIN line l ON l.code = e.line_code
JOIN process p ON p.id = e.process_id
JOIN category c ON c.code = e.category_code
JOIN department d ON d.code = e.department_code
`;

function toEvent(r: Row): AndonEvent {
  return {
    id: r.id as string,
    plant: r.plant as string,
    lineCode: r.line_code as string,
    lineName: r.line_name as string,
    processId: r.process_id as number,
    processName: r.process_name as string,
    categoryCode: r.category_code as string,
    categoryName: r.category_name as string,
    departmentCode: r.department_code as string,
    departmentName: r.department_name as string,
    description: r.description as string,
    photoFile: (r.photo_file as string) ?? null,
    status: r.status as AndonStatus,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
    acknowledgedAt: (r.acknowledged_at as string) ?? null,
    acknowledgedBy: (r.acknowledged_by as string) ?? null,
    closedAt: (r.closed_at as string) ?? null,
    closedBy: (r.closed_by as string) ?? null,
    correctiveAction: (r.corrective_action as string) ?? null,
    updatedAt: r.updated_at as string,
  };
}

function toTransition(r: Row): AndonTransition {
  return {
    id: r.id as number,
    eventId: r.event_id as string,
    action: r.action as AndonTransition["action"],
    fromStatus: (r.from_status as AndonStatus) ?? null,
    toStatus: r.to_status as AndonStatus,
    userName: r.user_name as string,
    comment: (r.comment as string) ?? null,
    createdAt: r.created_at as string,
  };
}

// ---------------------------------------------------------------- master data

export function getMasterData(): MasterData {
  const db = getDb();
  return {
    plant: PLANT,
    lines: db
      .prepare("SELECT code, name FROM line WHERE active = 1 ORDER BY sort_order")
      .all()
      .map((r) => ({ code: r.code as string, name: r.name as string })),
    processes: db
      .prepare("SELECT id, line_code, name FROM process WHERE active = 1 ORDER BY line_code, sort_order")
      .all()
      .map((r) => ({ id: r.id as number, lineCode: r.line_code as string, name: r.name as string })),
    categories: db
      .prepare("SELECT code, name_ko, name_en, default_department FROM category WHERE active = 1 ORDER BY sort_order")
      .all()
      .map((r) => ({
        code: r.code as string,
        nameKo: r.name_ko as string,
        nameEn: r.name_en as string,
        defaultDepartment: r.default_department as string,
      })),
    departments: db
      .prepare("SELECT code, name_ko, name_en FROM department WHERE active = 1")
      .all()
      .map((r) => ({ code: r.code as string, nameKo: r.name_ko as string, nameEn: r.name_en as string })),
    users: db
      .prepare("SELECT id, name, department_code, role FROM app_user WHERE active = 1 ORDER BY id")
      .all()
      .map((r) => ({
        id: r.id as number,
        name: r.name as string,
        departmentCode: r.department_code as string,
        role: r.role as string,
      })),
  };
}

// ---------------------------------------------------------------- queries

export interface ListOptions {
  /** active = OPEN/ACK/IN_PROGRESS; board = active + closed in the last N minutes; all = everything */
  scope?: "active" | "board" | "all";
  department?: string;
  limit?: number;
  recentClosedMinutes?: number;
}

export function listEvents(opts: ListOptions = {}): AndonEvent[] {
  const db = getDb();
  const where: string[] = [];
  const params: (string | number)[] = [];
  const active = ACTIVE_STATUSES.map((s) => `'${s}'`).join(",");

  if (opts.scope === "active") {
    where.push(`e.status IN (${active})`);
  } else if (opts.scope === "board") {
    const since = new Date(Date.now() - (opts.recentClosedMinutes ?? 30) * 60_000).toISOString();
    where.push(`(e.status IN (${active}) OR e.closed_at >= ?)`);
    params.push(since);
  }
  if (opts.department) {
    where.push("e.department_code = ?");
    params.push(opts.department);
  }
  // History: newest first. Boards: RED first, then YELLOW, then GREEN; oldest first within each.
  const order =
    opts.scope === "all"
      ? "e.created_at DESC"
      : "CASE e.status WHEN 'OPEN' THEN 0 WHEN 'CLOSED' THEN 2 ELSE 1 END, e.created_at ASC";
  const sql = EVENT_SELECT + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + ` ORDER BY ${order} LIMIT ?`;
  params.push(opts.limit ?? 500);
  return db.prepare(sql).all(...params).map(toEvent);
}

export function getEvent(id: string): AndonEvent | null {
  const r = getDb().prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id);
  return r ? toEvent(r) : null;
}

export function getTransitions(id: string): AndonTransition[] {
  return getDb()
    .prepare("SELECT * FROM andon_transition WHERE event_id = ? ORDER BY id")
    .all(id)
    .map(toTransition);
}

export function getNotifications(id: string): NotificationLogEntry[] {
  return getDb()
    .prepare("SELECT * FROM notification_log WHERE event_id = ? ORDER BY id")
    .all(id)
    .map((r) => ({
      id: r.id as number,
      eventId: r.event_id as string,
      provider: r.provider as string,
      recipient: r.recipient as string,
      status: r.status as "SENT" | "FAILED",
      message: r.message as string,
      error: (r.error as string) ?? null,
      createdAt: r.created_at as string,
    }));
}

// ---------------------------------------------------------------- create

export interface CreateAndonInput {
  lineCode: string;
  processId: number;
  categoryCode: string;
  description: string;
  createdBy?: string;
  clientRequestId?: string;
  photoFile?: string | null;
  /** Only used by the demo seeder to back-date events. */
  createdAt?: string;
}

/** Korea time date as YYYYMMDD, used in ANDON IDs. */
function kstDateKey(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10).replaceAll("-", "");
}

export function findByClientRequestId(clientRequestId: string): AndonEvent | null {
  const r = getDb().prepare(`${EVENT_SELECT} WHERE e.client_request_id = ?`).get(clientRequestId);
  return r ? toEvent(r) : null;
}

/**
 * Creates an ANDON event and its CREATE history row in one transaction.
 * Returns `duplicate: true` (and the original event) if the same clientRequestId was already stored.
 */
export function createEvent(input: CreateAndonInput): { event: AndonEvent; duplicate: boolean } {
  const db = getDb();
  const description = (input.description ?? "").trim();
  const createdBy = (input.createdBy ?? "").trim() || "작업자";

  if (input.clientRequestId) {
    const existing = findByClientRequestId(input.clientRequestId);
    if (existing) return { event: existing, duplicate: true };
  }

  if (!description) throw new AndonError(400, "이상 내용을 입력하세요.", "DESCRIPTION_REQUIRED");
  if (description.length > 500) throw new AndonError(400, "이상 내용은 500자 이내로 입력하세요.", "DESCRIPTION_TOO_LONG");

  const proc = db
    .prepare("SELECT id FROM process WHERE id = ? AND line_code = ? AND active = 1")
    .get(input.processId, input.lineCode);
  if (!proc) throw new AndonError(400, "라인/공정 선택이 올바르지 않습니다.", "INVALID_PROCESS");

  const cat = db.prepare("SELECT default_department FROM category WHERE code = ? AND active = 1").get(input.categoryCode);
  if (!cat) throw new AndonError(400, "이상 유형 선택이 올바르지 않습니다.", "INVALID_CATEGORY");

  const createdAt = input.createdAt ?? nowIso();
  const id = transaction(db, () => {
    const prefix = `AND-${kstDateKey(createdAt)}-`;
    const last = db
      .prepare("SELECT id FROM andon_event WHERE id LIKE ? ORDER BY id DESC LIMIT 1")
      .get(`${prefix}%`) as { id: string } | undefined;
    const seq = last ? Number(last.id.slice(prefix.length)) + 1 : 1;
    const newId = `${prefix}${String(seq).padStart(3, "0")}`;

    db.prepare(
      `INSERT INTO andon_event (id, plant, line_code, process_id, category_code, department_code, description,
         photo_file, status, created_by, created_at, updated_at, client_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
    ).run(
      newId,
      PLANT,
      input.lineCode,
      input.processId,
      input.categoryCode,
      cat.default_department as string,
      description,
      input.photoFile ?? null,
      createdBy,
      createdAt,
      createdAt,
      input.clientRequestId ?? null,
    );
    db.prepare(
      `INSERT INTO andon_transition (event_id, action, from_status, to_status, user_name, comment, created_at)
       VALUES (?, 'CREATE', NULL, 'OPEN', ?, ?, ?)`,
    ).run(newId, createdBy, description, createdAt);
    return newId;
  });

  return { event: getEvent(id)!, duplicate: false };
}

// ---------------------------------------------------------------- transitions

export interface TransitionInput {
  action: TransitionAction;
  userName: string;
  comment?: string;
  /** Only used by the demo seeder to back-date transitions. */
  at?: string;
}

export function transitionEvent(id: string, input: TransitionInput): AndonEvent {
  const db = getDb();
  const rule = TRANSITION_RULES[input.action];
  if (!rule) throw new AndonError(400, "알 수 없는 조치입니다.", "INVALID_ACTION");

  const userName = (input.userName ?? "").trim();
  if (!userName) throw new AndonError(400, "담당자를 선택하세요.", "USER_REQUIRED");
  const comment = (input.comment ?? "").trim();
  if (rule.commentRequired && !comment) {
    throw new AndonError(400, "조치 내용을 입력하세요.", "COMMENT_REQUIRED");
  }
  if (comment.length > 1000) throw new AndonError(400, "조치 내용은 1000자 이내로 입력하세요.", "COMMENT_TOO_LONG");

  const at = input.at ?? nowIso();

  transaction(db, () => {
    const row = db.prepare("SELECT status FROM andon_event WHERE id = ?").get(id) as { status: AndonStatus } | undefined;
    if (!row) throw new AndonError(404, "ANDON을 찾을 수 없습니다.", "NOT_FOUND");
    if (!rule.from.includes(row.status)) {
      throw new AndonError(
        409,
        `현재 상태(${row.status})에서는 ${input.action}을(를) 할 수 없습니다. 화면을 새로고침하세요.`,
        "INVALID_TRANSITION",
      );
    }

    const sets = ["status = ?", "updated_at = ?"];
    const params: (string | null)[] = [rule.to, at];
    if (input.action === "ACKNOWLEDGE") {
      sets.push("acknowledged_at = ?", "acknowledged_by = ?");
      params.push(at, userName);
    } else if (input.action === "CLOSE") {
      sets.push("closed_at = ?", "closed_by = ?", "corrective_action = ?");
      params.push(at, userName, comment);
    }
    // Guard on the status we just read, so a concurrent change can never be overwritten.
    const res = db
      .prepare(`UPDATE andon_event SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
      .run(...params, id, row.status);
    if (res.changes !== 1) throw new AndonError(409, "다른 사용자가 먼저 처리했습니다. 화면을 새로고침하세요.", "CONFLICT");

    db.prepare(
      `INSERT INTO andon_transition (event_id, action, from_status, to_status, user_name, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.action, row.status, rule.to, userName, comment || null, at);
  });

  return getEvent(id)!;
}

// ---------------------------------------------------------------- stats

/** Start of the current day in Korea time, as UTC ISO string. */
export function kstStartOfToday(): string {
  const kstNow = new Date(Date.now() + 9 * 3600_000);
  kstNow.setUTCHours(0, 0, 0, 0);
  return new Date(kstNow.getTime() - 9 * 3600_000).toISOString();
}

/** Counters for the dashboard header: current open / in progress, closed since 00:00 KST. */
export function getBoardCounts() {
  const r = getDb()
    .prepare(
      `SELECT SUM(status = 'OPEN') AS open,
              SUM(status IN ('ACKNOWLEDGED','IN_PROGRESS')) AS in_progress,
              SUM(status = 'CLOSED' AND closed_at >= ?) AS closed_today,
              SUM(created_at >= ?) AS created_today
       FROM andon_event`,
    )
    .get(kstStartOfToday(), kstStartOfToday()) as Row;
  return {
    open: Number(r.open ?? 0),
    inProgress: Number(r.in_progress ?? 0),
    closedToday: Number(r.closed_today ?? 0),
    createdToday: Number(r.created_today ?? 0),
  };
}

export interface AndonStats {
  from: string;
  to: string;
  total: number;
  open: number;
  inProgress: number;
  closed: number;
  avgResponseSec: number | null;
  avgResolutionSec: number | null;
  byLine: { name: string; count: number }[];
  byCategory: { name: string; count: number }[];
  repeatTop5: { lineName: string; processName: string; categoryName: string; description: string; count: number }[];
}

export function getStats(from: string, to: string): AndonStats {
  const db = getDb();
  const range = "e.created_at >= ? AND e.created_at < ?";
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS total,
         SUM(e.status = 'OPEN') AS open,
         SUM(e.status IN ('ACKNOWLEDGED','IN_PROGRESS')) AS in_progress,
         SUM(e.status = 'CLOSED') AS closed,
         AVG(CASE WHEN e.acknowledged_at IS NOT NULL
             THEN (julianday(e.acknowledged_at) - julianday(e.created_at)) * 86400 END) AS avg_response,
         AVG(CASE WHEN e.closed_at IS NOT NULL
             THEN (julianday(e.closed_at) - julianday(e.created_at)) * 86400 END) AS avg_resolution
       FROM andon_event e WHERE ${range}`,
    )
    .get(from, to) as Row;

  const group = (col: string, join: string) =>
    db
      .prepare(`SELECT ${col} AS name, COUNT(*) AS count FROM andon_event e ${join} WHERE ${range} GROUP BY ${col} ORDER BY count DESC`)
      .all(from, to)
      .map((r) => ({ name: r.name as string, count: r.count as number }));

  const repeatTop5 = db
    .prepare(
      `SELECT l.name AS line_name, p.name AS process_name, c.name_ko AS category_name,
              MIN(e.description) AS description, COUNT(*) AS count
       FROM andon_event e
       JOIN line l ON l.code = e.line_code
       JOIN process p ON p.id = e.process_id
       JOIN category c ON c.code = e.category_code
       WHERE ${range}
       GROUP BY e.line_code, e.process_id, e.category_code, lower(trim(e.description))
       HAVING COUNT(*) >= 2
       ORDER BY count DESC LIMIT 5`,
    )
    .all(from, to)
    .map((r) => ({
      lineName: r.line_name as string,
      processName: r.process_name as string,
      categoryName: r.category_name as string,
      description: r.description as string,
      count: r.count as number,
    }));

  const num = (v: unknown) => (v == null ? null : Math.round(Number(v)));
  return {
    from,
    to,
    total: Number(summary.total ?? 0),
    open: Number(summary.open ?? 0),
    inProgress: Number(summary.in_progress ?? 0),
    closed: Number(summary.closed ?? 0),
    avgResponseSec: num(summary.avg_response),
    avgResolutionSec: num(summary.avg_resolution),
    byLine: group("l.name", "JOIN line l ON l.code = e.line_code"),
    byCategory: group("c.name_ko", "JOIN category c ON c.code = e.category_code"),
    repeatTop5,
  };
}
