// ANDON business logic. All state changes go through this module.
import {
  ACTIVE_STATUSES,
  TRANSITION_RULES,
  type AndonEvent,
  type AndonStatus,
  type AndonTransition,
  type MasterData,
  type NotificationLogEntry,
  type RoleCode,
  type TransitionAction,
} from "../domain.ts";
import { getDb, nowIso, transaction } from "./db.ts";
import { AndonError, type AuditInfo } from "./errors.ts";
import { departmentAliases, departmentLabel, resolveResponsibility, validateResponder } from "./routingService.ts";

export { AndonError, type AuditInfo };

const NO_AUDIT: AuditInfo = { deviceId: null, clientIp: null, userAgent: null };

type Row = Record<string, unknown>;

const EVENT_SELECT = `
SELECT e.*, l.name AS line_name, p.name AS process_name,
       c.name_ko AS category_name, d.name_ko AS department_name, COALESCE(d.display_code, d.code) AS department_display
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
    departmentLabel: `${r.department_display as string} · ${r.department_name as string}`,
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
    userId: (r.user_id as number | null) ?? null,
    userDepartment: (r.user_department as string | null) ?? null,
    userDepartmentLabel: r.user_department ? departmentLabel(r.user_department as string) : null,
    userRole: (r.user_role as string | null) ?? null,
    comment: (r.comment as string) ?? null,
    createdAt: r.created_at as string,
    deviceId: (r.device_id as string | null) ?? null,
    clientIp: (r.client_ip as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null,
  };
}

function insertTransition(
  eventId: string,
  t: {
    action: string;
    from: AndonStatus | null;
    to: AndonStatus;
    userName: string;
    userId: number | null;
    /** Snapshot of the actor at the time of the action (department / role can change later). */
    userDepartment: string | null;
    userRole: string | null;
    comment: string | null;
    at: string;
  },
  audit: AuditInfo,
) {
  getDb()
    .prepare(
      `INSERT INTO andon_transition
         (event_id, action, from_status, to_status, user_name, user_id, user_department, user_role, comment, created_at,
          device_id, client_ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId, t.action, t.from, t.to, t.userName, t.userId, t.userDepartment, t.userRole, t.comment, t.at,
      audit.deviceId, audit.clientIp, audit.userAgent,
    );
}

// ---------------------------------------------------------------- master data

export function getMasterData(): MasterData {
  const db = getDb();
  const plants = db
    .prepare("SELECT code, name, name_ko FROM plant WHERE active = 1 ORDER BY code")
    .all()
    .map((r) => ({ code: r.code as string, name: r.name as string, nameKo: r.name_ko as string }));
  return {
    plant: plants[0]?.name ?? "",
    plants,
    lines: db
      .prepare("SELECT code, name, plant_code FROM line WHERE active = 1 ORDER BY sort_order")
      .all()
      .map((r) => ({ code: r.code as string, name: r.name as string, plantCode: r.plant_code as string })),
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
      .prepare("SELECT code, COALESCE(display_code, code) AS display_code, name_ko, name_en FROM department WHERE active = 1 ORDER BY sort_order")
      .all()
      .map((r) => ({
        code: r.code as string,
        displayCode: r.display_code as string,
        label: `${r.display_code as string} · ${r.name_ko as string}`,
        nameKo: r.name_ko as string,
        nameEn: r.name_en as string,
      })),
    roles: db
      .prepare("SELECT code, name_ko, name_en, can_respond, escalation_level FROM role ORDER BY sort_order")
      .all()
      .map((r) => ({
        code: r.code as RoleCode,
        nameKo: r.name_ko as string,
        nameEn: r.name_en as string,
        canRespond: r.can_respond === 1,
        escalationLevel: (r.escalation_level as number | null) ?? null,
      })),
  };
}

// ---------------------------------------------------------------- queries

export interface ListOptions {
  /** active = OPEN/ACK/IN_PROGRESS; board = active + closed in the last N minutes; all = everything */
  scope?: "active" | "board" | "all";
  department?: string;
  /** Only events this user is responsible for (their department, incl. pre-v3 department codes). */
  responderId?: number;
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
  if (opts.responderId != null) {
    const u = db.prepare("SELECT department_code FROM app_user WHERE id = ? AND active = 1").get(opts.responderId) as
      | { department_code: string }
      | undefined;
    const codes = u ? departmentAliases(u.department_code) : [];
    if (codes.length === 0) return [];
    where.push(`e.department_code IN (${codes.map(() => "?").join(",")})`);
    params.push(...codes);
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
  audit?: AuditInfo;
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

  const cat = db.prepare("SELECT 1 FROM category WHERE code = ? AND active = 1").get(input.categoryCode);
  if (!cat) throw new AndonError(400, "이상 유형 선택이 올바르지 않습니다.", "INVALID_CATEGORY");

  const plant = db
    .prepare("SELECT p.name FROM line l JOIN plant p ON p.code = l.plant_code WHERE l.code = ?")
    .get(input.lineCode) as { name: string } | undefined;
  const createdAt = input.createdAt ?? nowIso();
  const id = transaction(db, () => {
    const prefix = `AND-${kstDateKey(createdAt)}-`;
    const last = db
      .prepare("SELECT id FROM andon_event WHERE id LIKE ? ORDER BY id DESC LIMIT 1")
      .get(`${prefix}%`) as { id: string } | undefined;
    const seq = last ? Number(last.id.slice(prefix.length)) + 1 : 1;
    const newId = `${prefix}${String(seq).padStart(3, "0")}`;
    // Responsibility is decided once, at creation, by the routing rules (src/lib/routing.ts).
    const resp = resolveResponsibility(input.lineCode, input.processId, input.categoryCode);

    db.prepare(
      `INSERT INTO andon_event (id, plant, line_code, process_id, category_code, department_code, routing_rule_id,
         description, photo_file, status, created_by, created_at, updated_at, client_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
    ).run(
      newId,
      plant?.name ?? "",
      input.lineCode,
      input.processId,
      input.categoryCode,
      resp.departmentCode,
      resp.routingRuleId,
      description,
      input.photoFile ?? null,
      createdBy,
      createdAt,
      createdAt,
      input.clientRequestId ?? null,
    );
    // Operators have no accounts yet: user_id stays NULL, the typed name is recorded as-is.
    insertTransition(
      newId,
      { action: "CREATE", from: null, to: "OPEN", userName: createdBy, userId: null, userDepartment: null, userRole: null, comment: description, at: createdAt },
      input.audit ?? NO_AUDIT,
    );
    return newId;
  });

  return { event: getEvent(id)!, duplicate: false };
}

// ---------------------------------------------------------------- transitions

export interface TransitionInput {
  action: TransitionAction;
  /** Responder (from the session for HTTP requests). */
  userId?: number | null;
  /** Server-internal callers only (demo seeder): must match exactly one active, eligible user. */
  userName?: string | null;
  comment?: string;
  audit?: AuditInfo;
  /** Only used by the demo seeder to back-date transitions. */
  at?: string;
}

export function transitionEvent(id: string, input: TransitionInput): AndonEvent {
  const db = getDb();
  const rule = TRANSITION_RULES[input.action];
  if (!rule) throw new AndonError(400, "알 수 없는 조치입니다.", "INVALID_ACTION");

  if (input.userId == null && !(input.userName ?? "").trim()) {
    throw new AndonError(400, "담당자를 선택하세요.", "USER_REQUIRED");
  }
  const comment = (input.comment ?? "").trim();
  if (rule.commentRequired && !comment) {
    throw new AndonError(400, "조치 내용을 입력하세요.", "COMMENT_REQUIRED");
  }
  if (comment.length > 1000) throw new AndonError(400, "조치 내용은 1000자 이내로 입력하세요.", "COMMENT_TOO_LONG");

  const at = input.at ?? nowIso();

  transaction(db, () => {
    const row = db.prepare("SELECT status, department_code FROM andon_event WHERE id = ?").get(id) as
      | { status: AndonStatus; department_code: string }
      | undefined;
    if (!row) throw new AndonError(404, "ANDON을 찾을 수 없습니다.", "NOT_FOUND");
    // Who: must be an active, responder-capable user of the event's responsible department.
    const responder = validateResponder({ userId: input.userId, userName: input.userName }, row.department_code);
    const userName = responder.name;
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

    insertTransition(
      id,
      {
        action: input.action,
        from: row.status,
        to: rule.to,
        userName,
        userId: responder.id,
        userDepartment: responder.departmentCode,
        userRole: responder.role,
        comment: comment || null,
        at,
      },
      input.audit ?? NO_AUDIT,
    );
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
