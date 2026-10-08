// ANDON business logic. All state changes go through this module.
import {
  ACTIVE_STATUSES,
  TRANSITION_RULES,
  type AndonEvent,
  type AndonStatus,
  type AndonTransition,
  type CallTargetDepartment,
  UAP_LABEL,
  type MasterData,
  type NotificationLogEntry,
  type RoleCode,
  type TransitionAction,
} from "../domain.ts";
import { selfRegistrationOpen } from "./auth.ts";
import { db, nowIso } from "./db.ts";
import { CALL_SITUATIONS } from "./masterData.ts";
import { AndonError, type AuditInfo } from "./errors.ts";
import { shiftSnapshotForLine } from "./shiftService.ts";
import { departmentAliases, departmentLabelMap, effectiveDepartment, resolveResponsibility, validateResponder } from "./routingService.ts";

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
    departments: [{ code: r.department_code as string, label: `${r.department_display as string} · ${r.department_name as string}` }],
    situations: situationNames(r.situations),
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

function situationNames(json: unknown): string[] {
  if (typeof json !== "string" || !json) return [];
  try {
    const codes = JSON.parse(json) as string[];
    return codes.map((c) => CALL_SITUATIONS.find((s) => s.code === c)?.nameKo ?? c);
  } catch {
    return [];
  }
}

/** Adds the call's departments (v9 andon_event_department) to events; older events keep their single one. */
async function withDepartments(events: AndonEvent[]): Promise<AndonEvent[]> {
  if (events.length === 0) return events;
  const rows = await db.all(
    `SELECT x.event_id, x.department_code, COALESCE(d.display_code, d.code) AS display, d.name_ko
     FROM andon_event_department x JOIN department d ON d.code = x.department_code
     WHERE x.event_id IN (${events.map(() => "?").join(",")}) ORDER BY x.event_id, x.sort_order`,
    ...events.map((e) => e.id),
  );
  const byEvent = new Map<string, { code: string; label: string }[]>();
  for (const r of rows) {
    const list = byEvent.get(r.event_id as string) ?? [];
    list.push({ code: r.department_code as string, label: r.department_code === "UAP" ? UAP_LABEL : `${r.display as string} · ${r.name_ko as string}` });
    byEvent.set(r.event_id as string, list);
  }
  for (const e of events) {
    const list = byEvent.get(e.id);
    if (list?.length) {
      e.departments = list;
      e.departmentLabel = list.map((d) => d.label).join(", ");
    }
  }
  return events;
}

/**
 * Departments whose members may perform `action` on an event. Plant meeting 2026-10-07: a QC event is
 * closed by UAP (production confirms) — QC acknowledges and acts, but CLOSE belongs to UAP.
 */
export async function actionDepartmentCodes(eventId: string, fallback: string, action: TransitionAction): Promise<string[]> {
  const deps = await eventDepartmentCodes(eventId, fallback);
  if (action === "CLOSE") {
    // QC and PC&L events are closed by UAP (2026-10-07 / 08); MT closes its own repair
    const effective = await Promise.all(deps.map((d) => effectiveDepartment(d)));
    if (effective.includes("QC") || effective.includes("PCL")) return ["UAP"];
  }
  return deps;
}

/** Departments of a stored event (v9 rows, else its single department_code). */
export async function eventDepartmentCodes(eventId: string, fallback: string): Promise<string[]> {
  const rows = await db.all("SELECT department_code FROM andon_event_department WHERE event_id = ? ORDER BY sort_order", eventId);
  return rows.length ? rows.map((r) => r.department_code as string) : [fallback];
}

function toTransition(r: Row, labels: Map<string, string>): AndonTransition {
  return {
    id: r.id as number,
    eventId: r.event_id as string,
    action: r.action as AndonTransition["action"],
    fromStatus: (r.from_status as AndonStatus) ?? null,
    toStatus: r.to_status as AndonStatus,
    userName: r.user_name as string,
    userId: (r.user_id as number | null) ?? null,
    userDepartment: (r.user_department as string | null) ?? null,
    userDepartmentLabel: r.user_department ? (labels.get(r.user_department as string) ?? (r.user_department as string)) : null,
    userRole: (r.user_role as string | null) ?? null,
    comment: (r.comment as string) ?? null,
    createdAt: r.created_at as string,
    deviceId: (r.device_id as string | null) ?? null,
    clientIp: (r.client_ip as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null,
  };
}

async function insertTransition(
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
  (await db.run(`INSERT INTO andon_transition
         (event_id, action, from_status, to_status, user_name, user_id, user_department, user_role, comment, created_at,
          device_id, client_ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, eventId, t.action, t.from, t.to, t.userName, t.userId, t.userDepartment, t.userRole, t.comment, t.at,
      audit.deviceId, audit.clientIp, audit.userAgent));
}

// ---------------------------------------------------------------- master data

export async function getMasterData(): Promise<MasterData> {
  const plants = (await db.all("SELECT code, name, name_ko FROM plant WHERE active = 1 ORDER BY code"))
    .map((r) => ({ code: r.code as string, name: r.name as string, nameKo: r.name_ko as string }));
  return {
    plant: plants[0]?.name ?? "",
    plants,
    uapAreas: (await db.all("SELECT code, name FROM uap_area WHERE active = 1 ORDER BY sort_order"))
      .map((r) => ({ code: r.code as string, name: r.name as string })),
    lines: (await db.all("SELECT code, name, plant_code, uap_area_code FROM line WHERE active = 1 ORDER BY sort_order"))
      .map((r) => ({ code: r.code as string, name: r.name as string, plantCode: r.plant_code as string, uapAreaCode: (r.uap_area_code as string | null) ?? null })),
    processes: (await db.all("SELECT id, line_code, name, placeholder FROM process WHERE active = 1 ORDER BY line_code, sort_order"))
      .map((r) => ({ id: r.id as number, lineCode: r.line_code as string, name: r.name as string, placeholder: r.placeholder === 1 })),
    categories: (await db.all("SELECT code, name_ko, name_en, default_department FROM category WHERE active = 1 ORDER BY sort_order"))
      .map((r) => ({
        code: r.code as string,
        nameKo: r.name_ko as string,
        nameEn: r.name_en as string,
        defaultDepartment: r.default_department as string,
      })),
    departments: (await db.all("SELECT code, COALESCE(display_code, code) AS display_code, name_ko, name_en FROM department WHERE active = 1 ORDER BY sort_order"))
      .map((r) => ({
        code: r.code as string,
        displayCode: r.display_code as string,
        label: `${r.display_code as string} · ${r.name_ko as string}`,
        nameKo: r.name_ko as string,
        nameEn: r.name_en as string,
      })),
    roles: (await db.all("SELECT code, name_ko, name_en, can_respond, escalation_level FROM role ORDER BY sort_order"))
      .map((r) => ({
        code: r.code as RoleCode,
        nameKo: r.name_ko as string,
        nameEn: r.name_en as string,
        canRespond: r.can_respond === 1,
        escalationLevel: (r.escalation_level as number | null) ?? null,
      })),
    selfRegistration: selfRegistrationOpen(),
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

export async function listEvents(opts: ListOptions = {}): Promise<AndonEvent[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const active = ACTIVE_STATUSES.map((s) => `'${s}'`).join(",");

  if (opts.scope === "active") {
    where.push(`e.status IN (${active})`);
  } else if (opts.scope === "board") {
    // plant meeting 2026-10-07: a completed ANDON stays on the board (green) for 24 hours
    const since = new Date(Date.now() - (opts.recentClosedMinutes ?? 24 * 60) * 60_000).toISOString();
    where.push(`(e.status IN (${active}) OR e.closed_at >= ?)`);
    params.push(since);
  }
  // an event belongs to every department of its call (v9) — or to its single department_code
  const inDepartments = (codes: string[]) => {
    const q = codes.map(() => "?").join(",");
    where.push(`(e.department_code IN (${q}) OR EXISTS (SELECT 1 FROM andon_event_department x WHERE x.event_id = e.id AND x.department_code IN (${q})))`);
    params.push(...codes, ...codes);
  };
  if (opts.department) inDepartments([opts.department]);
  if (opts.responderId != null) {
    const u = (await db.get("SELECT department_code FROM app_user WHERE id = ? AND active = 1", opts.responderId)) as
      | { department_code: string }
      | undefined;
    const codes = u ? await departmentAliases(u.department_code) : [];
    if (codes.length === 0) return [];
    inDepartments(codes);
  }
  // History: newest first. Boards: RED first, then YELLOW, then GREEN; oldest first within each.
  const order =
    opts.scope === "all"
      ? "e.created_at DESC"
      : "CASE e.status WHEN 'OPEN' THEN 0 WHEN 'CLOSED' THEN 2 ELSE 1 END, e.created_at ASC";
  const sql = EVENT_SELECT + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + ` ORDER BY ${order} LIMIT ?`;
  params.push(opts.limit ?? 500);
  return withDepartments((await db.all(sql, ...params)).map(toEvent));
}

export async function getEvent(id: string): Promise<AndonEvent | null> {
  const r = (await db.get(`${EVENT_SELECT} WHERE e.id = ?`, id));
  return r ? (await withDepartments([toEvent(r)]))[0] : null;
}

export async function getTransitions(id: string): Promise<AndonTransition[]> {
  const labels = await departmentLabelMap(); // one query for all rows
  return (await db.all("SELECT * FROM andon_transition WHERE event_id = ? ORDER BY id", id)).map((r) => toTransition(r, labels));
}

export async function getNotifications(id: string): Promise<NotificationLogEntry[]> {
  return (await db.all("SELECT * FROM notification_log WHERE event_id = ? ORDER BY id", id))
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
  /** The logged-in caller (GAP leader). HTTP calls always pass it; it replaces `createdBy`. */
  caller?: { id: number; name: string; departmentCode: string; role: string };
  /** Departments chosen by the caller (v9). Omitted = the routing rule decides one department. */
  departments?: string[];
  /** People chosen to receive the message (must belong to the chosen departments). Omitted = department rule. */
  recipientIds?: number[];
  /** Situations picked at the call (CALL_SITUATIONS codes). */
  situations?: string[];
}

/** Departments a GAP leader calls (plant meeting 2026-10-07/08: QC, MT, PC&L — plus UAP, added separately). */
export const CALLABLE_DEPARTMENTS = ["QC", "MT", "PCL"];
export async function callableDepartments(): Promise<{ code: string; label: string }[]> {
  return (await db.all(`SELECT code, COALESCE(display_code, code) AS display, name_ko FROM department WHERE active = 1 AND code IN (${CALLABLE_DEPARTMENTS.map(() => "?").join(",")}) ORDER BY sort_order`, ...CALLABLE_DEPARTMENTS))
    .map((r) => ({ code: r.code as string, label: `${r.display as string} · ${r.name_ko as string}` }));
}

/**
 * Call targets with the people who can respond there (names only — no contact data): the callable
 * departments, then UAP (production). Plant meeting 2026-10-07: every call except PC&L also messages
 * UAP by default — the line's supervisor, the line's GAP leader (the team on shift; both while the shift
 * is unresolved) and the UAP default recipients (app_user.call_default: UAP team leader, UAP 책임).
 */
/** The line's UAP owners now: its supervisor and its GAP leader (team on shift; both while unresolved). */
export async function lineUapPeople(lineCode: string): Promise<number[]> {
  const shift = await shiftSnapshotForLine(lineCode, nowIso());
  const rows = await db.all(
    `SELECT a.user_id, a.assignment_role, a.id FROM line_assignment a JOIN app_user u ON u.id = a.user_id
     WHERE a.line_code = ? AND a.active = 1 AND u.active = 1 AND (a.effective_to IS NULL OR a.effective_to > ?)`,
    lineCode,
    nowIso(),
  );
  const out = new Set<number>();
  for (const r of rows) {
    const gapOnShift = shift.gapLeaderAssignmentId == null || r.id === shift.gapLeaderAssignmentId;
    if (r.assignment_role === "SUPERVISOR" || (r.assignment_role === "GAP_LEADER" && gapOnShift)) out.add(r.user_id as number);
  }
  return [...out];
}

export async function callTargets(lineCode?: string): Promise<CallTargetDepartment[]> {
  const deps = await callableDepartments();
  const people = await db.all(
    `SELECT u.id, u.name, u.department_code, u.role, u.call_default, r.name_ko AS role_name FROM app_user u JOIN role r ON r.code = u.role
     WHERE u.active = 1 AND r.can_respond = 1 ORDER BY r.sort_order DESC, u.name`,
  );
  const member = (p: Record<string, unknown>) => ({ id: p.id as number, name: p.name as string, roleName: p.role_name as string });
  const uapDefaults = new Set<number>(people.filter((p) => p.department_code === "UAP" && p.call_default === 1).map((p) => p.id as number));
  if (lineCode) for (const id of await lineUapPeople(lineCode)) uapDefaults.add(id);
  const uapMembers = people.filter((p) => p.department_code === "UAP");
  return [
    ...deps.map((d) => ({
      ...d,
      members: people.filter((p) => p.department_code === d.code).map(member),
      supervisorIds: people.filter((p) => p.department_code === d.code && p.role === "SUPERVISOR").map((p) => p.id as number),
    })),
    { code: "UAP", label: UAP_LABEL, members: uapMembers.map(member), defaultMemberIds: uapMembers.map((p) => p.id as number).filter((id) => uapDefaults.has(id)) },
  ];
}

/** Validates the caller's choice: departments (deduplicated, in order) and recipients with their department. */
async function validateCall(departments: string[], recipientIds: number[]) {
  // UAP (production) may be called too; "SV" is the older name of that target.
  const allowed = new Set([...(await callableDepartments()).map((d) => d.code), "UAP", "SV"]);
  const chosen = [...new Set(departments.map((d) => String(d).trim()).filter(Boolean))];
  if (chosen.length === 0) throw new AndonError(400, "조치부서를 1개 이상 선택하세요.", "DEPARTMENT_REQUIRED");
  if (chosen.length > 8 || chosen.some((d) => !allowed.has(d))) throw new AndonError(400, "조치부서 선택이 올바르지 않습니다.", "INVALID_DEPARTMENT");
  const deps = [...new Set(chosen.map((d) => (d === "SV" ? "UAP" : d)))];
  const ids = [...new Set(recipientIds)];
  if (ids.length > 200 || ids.some((i) => !Number.isInteger(i) || i <= 0)) throw new AndonError(400, "받는 사람 선택이 올바르지 않습니다.", "INVALID_RECIPIENT");
  const recipients: { id: number; departmentCode: string }[] = [];
  for (const id of ids) {
    const u = (await db.get("SELECT u.department_code FROM app_user u JOIN role r ON r.code = u.role WHERE u.id = ? AND u.active = 1 AND r.can_respond = 1", id)) as
      | { department_code: string }
      | undefined;
    if (!u || !deps.includes(u.department_code)) throw new AndonError(400, "받는 사람은 선택한 조치부서의 담당자여야 합니다.", "INVALID_RECIPIENT");
    recipients.push({ id, departmentCode: u.department_code });
  }
  return { deps, recipients };
}

/** Korea time date as YYYYMMDD, used in ANDON IDs. */
function kstDateKey(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10).replaceAll("-", "");
}

export async function findByClientRequestId(clientRequestId: string): Promise<AndonEvent | null> {
  const r = (await db.get(`${EVENT_SELECT} WHERE e.client_request_id = ?`, clientRequestId));
  return r ? (await withDepartments([toEvent(r)]))[0] : null;
}

/**
 * Creates an ANDON event and its CREATE history row in one transaction.
 * Returns `duplicate: true` (and the original event) if the same clientRequestId was already stored.
 */
export async function createEvent(input: CreateAndonInput): Promise<{ event: AndonEvent; duplicate: boolean }> {
  const description = (input.description ?? "").trim();
  const createdBy = input.caller?.name ?? ((input.createdBy ?? "").trim() || "작업자");

  if (input.clientRequestId) {
    const existing = await findByClientRequestId(input.clientRequestId);
    if (existing) return { event: existing, duplicate: true };
  }

  if (!description) throw new AndonError(400, "이상 내용을 입력하세요.", "DESCRIPTION_REQUIRED");
  if (description.length > 500) throw new AndonError(400, "이상 내용은 500자 이내로 입력하세요.", "DESCRIPTION_TOO_LONG");

  const proc = (await db.get("SELECT id FROM process WHERE id = ? AND line_code = ? AND active = 1", input.processId, input.lineCode));
  if (!proc) throw new AndonError(400, "라인/공정 선택이 올바르지 않습니다.", "INVALID_PROCESS");

  const cat = (await db.get("SELECT 1 FROM category WHERE code = ? AND active = 1", input.categoryCode));
  if (!cat) throw new AndonError(400, "이상 유형 선택이 올바르지 않습니다.", "INVALID_CATEGORY");
  const call = input.departments ? await validateCall(input.departments, input.recipientIds ?? []) : null;
  const situations = [...new Set((input.situations ?? []).map(String))];
  if (situations.some((c) => !CALL_SITUATIONS.some((s) => s.code === c))) throw new AndonError(400, "상황 선택이 올바르지 않습니다.", "INVALID_SITUATION");
  // 예방보전 (preventive maintenance): planned MT work registered by UAP — yellow at once, short text only
  const preventive = situations.includes("MT_PREVENTIVE");
  if (preventive && description.length > 100) throw new AndonError(400, "예방보전 안내는 100자 이내로 입력하세요.", "DESCRIPTION_TOO_LONG");
  const startStatus: AndonStatus = preventive ? "ACKNOWLEDGED" : "OPEN";

  const plant = (await db.get("SELECT p.name FROM line l JOIN plant p ON p.code = l.plant_code WHERE l.code = ?", input.lineCode)) as { name: string } | undefined;
  const createdAt = input.createdAt ?? nowIso();
  // Shift context at creation (team, DAY/NIGHT, GAP leader / supervisor assignment). Never throws — an
  // unresolved shift (e.g. anchor not configured) is stored as UNRESOLVED and the ANDON goes ahead.
  const shift = await shiftSnapshotForLine(input.lineCode, createdAt);
  const id = await db.transaction(async () => {
    const prefix = `AND-${kstDateKey(createdAt)}-`;
    const last = (await db.get("SELECT id FROM andon_event WHERE id LIKE ? ORDER BY id DESC LIMIT 1", `${prefix}%`)) as { id: string } | undefined;
    const seq = last ? Number(last.id.slice(prefix.length)) + 1 : 1;
    const newId = `${prefix}${String(seq).padStart(3, "0")}`;
    // Responsibility is decided once, at creation: by the caller's choice (v9), else by the routing rules.
    const resp = call
      ? { departmentCode: call.deps[0], routingRuleId: null }
      : await resolveResponsibility(input.lineCode, input.processId, input.categoryCode);

    (await db.run(`INSERT INTO andon_event (id, plant, line_code, process_id, category_code, department_code, routing_rule_id,
         description, photo_file, status, created_by, created_at, updated_at, client_request_id,
         shift_status, shift_unresolved_reason, shift_team, shift_type, shift_operational_date, shift_start_at,
         gap_leader_assignment_id, supervisor_assignment_id, situations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId,
      plant?.name ?? "",
      input.lineCode,
      input.processId,
      input.categoryCode,
      resp.departmentCode,
      resp.routingRuleId,
      description,
      input.photoFile ?? null,
      startStatus,
      createdBy,
      createdAt,
      createdAt,
      input.clientRequestId ?? null,
      shift.status,
      shift.unresolvedReason,
      shift.team,
      shift.type,
      shift.operationalDate,
      shift.startAt,
      shift.gapLeaderAssignmentId,
      shift.supervisorAssignmentId,
      situations.length ? JSON.stringify(situations) : null));
    if (call) {
      for (const [i, d] of call.deps.entries()) {
        await db.run("INSERT INTO andon_event_department (event_id, department_code, sort_order) VALUES (?, ?, ?)", newId, d, i);
      }
      for (const r of call.recipients) {
        await db.run("INSERT INTO andon_call_recipient (event_id, user_id, department_code) VALUES (?, ?, ?)", newId, r.id, r.departmentCode);
      }
    }
    // The caller (GAP leader) is recorded with id / department / role. Server-internal callers without an
    // account (demo seeder) keep user_id NULL and the given name.
    const c = input.caller;
    await insertTransition(
      newId,
      { action: "CREATE", from: null, to: startStatus, userName: createdBy, userId: c?.id ?? null, userDepartment: c?.departmentCode ?? null, userRole: c?.role ?? null, comment: description, at: createdAt },
      input.audit ?? NO_AUDIT,
    );
    return newId;
  });

  return { event: (await getEvent(id))!, duplicate: false };
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

export async function transitionEvent(id: string, input: TransitionInput): Promise<AndonEvent> {
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

  await db.transaction(async () => {
    const row = (await db.get("SELECT status, department_code FROM andon_event WHERE id = ?", id)) as
      | { status: AndonStatus; department_code: string }
      | undefined;
    if (!row) throw new AndonError(404, "ANDON을 찾을 수 없습니다.", "NOT_FOUND");
    // Who: an active, responder-capable member of one of the event's responsible departments.
    const responder = await validateResponder({ userId: input.userId, userName: input.userName }, await actionDepartmentCodes(id, row.department_code, input.action));
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
    const res = (await db.run(`UPDATE andon_event SET ${sets.join(", ")} WHERE id = ? AND status = ?`, ...params, id, row.status));
    if (res.changes !== 1) throw new AndonError(409, "다른 사용자가 먼저 처리했습니다. 화면을 새로고침하세요.", "CONFLICT");

    await insertTransition(
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

  return (await getEvent(id))!;
}

// ---------------------------------------------------------------- stats

/** Start of the current day in Korea time, as UTC ISO string. */
export function kstStartOfToday(): string {
  const kstNow = new Date(Date.now() + 9 * 3600_000);
  kstNow.setUTCHours(0, 0, 0, 0);
  return new Date(kstNow.getTime() - 9 * 3600_000).toISOString();
}

/** Counters for the dashboard header: current open / in progress, closed since 00:00 KST. */
export async function getBoardCounts() {
  const r = (await db.get(`SELECT SUM(status = 'OPEN') AS open,
              SUM(status IN ('ACKNOWLEDGED','IN_PROGRESS')) AS in_progress,
              SUM(status = 'CLOSED' AND closed_at >= ?) AS closed_today,
              SUM(created_at >= ?) AS created_today
       FROM andon_event`, kstStartOfToday(), kstStartOfToday())) as Row;
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

export async function getStats(from: string, to: string): Promise<AndonStats> {
  const range = "e.created_at >= ? AND e.created_at < ?";
  const summary = (await db.get(`SELECT COUNT(*) AS total,
         SUM(e.status = 'OPEN') AS open,
         SUM(e.status IN ('ACKNOWLEDGED','IN_PROGRESS')) AS in_progress,
         SUM(e.status = 'CLOSED') AS closed,
         AVG(CASE WHEN e.acknowledged_at IS NOT NULL
             THEN (julianday(e.acknowledged_at) - julianday(e.created_at)) * 86400 END) AS avg_response,
         AVG(CASE WHEN e.closed_at IS NOT NULL
             THEN (julianday(e.closed_at) - julianday(e.created_at)) * 86400 END) AS avg_resolution
       FROM andon_event e WHERE ${range}`, from, to)) as Row;

  const group = async (col: string, join: string) =>
    (await db.all(`SELECT ${col} AS name, COUNT(*) AS count FROM andon_event e ${join} WHERE ${range} GROUP BY ${col} ORDER BY count DESC`, from, to))
      .map((r) => ({ name: r.name as string, count: r.count as number }));

  const repeatTop5 = (await db.all(`SELECT l.name AS line_name, p.name AS process_name, c.name_ko AS category_name,
              MIN(e.description) AS description, COUNT(*) AS count
       FROM andon_event e
       JOIN line l ON l.code = e.line_code
       JOIN process p ON p.id = e.process_id
       JOIN category c ON c.code = e.category_code
       WHERE ${range}
       GROUP BY e.line_code, e.process_id, e.category_code, lower(trim(e.description))
       HAVING COUNT(*) >= 2
       ORDER BY count DESC LIMIT 5`, from, to))
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
    byLine: await group("l.name", "JOIN line l ON l.code = e.line_code"),
    byCategory: await group("c.name_ko", "JOIN category c ON c.code = e.category_code"),
    repeatTop5,
  };
}
