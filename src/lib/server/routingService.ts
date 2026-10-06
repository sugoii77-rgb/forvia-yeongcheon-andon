// Responsibility & identity: which department owns an ANDON, who may respond, who is notified.
// All routing decisions are made here (server side). UI components never decide routing.
//
// Departments (schema v3): ME, MT, UAP, QC, PCL. Events created before v3 keep their original
// department code (e.g. QUALITY); `department.successor_code` maps it to the current department
// (QUALITY → QC), so those events stay actionable without rewriting history.
import type { ResponderSummary, Responsibility, RoleCode } from "../domain.ts";
import { resolveDepartment, responderProblem, type ResponderCandidate, type RoutingRule } from "../routing.ts";
import { db } from "./db.ts";
import { AndonError } from "./errors.ts";

type Row = Record<string, unknown>;

async function loadRules(categoryCode: string, lineCode: string): Promise<RoutingRule[]> {
  return (
    await db.all(
      `SELECT id, category_code, line_code, process_id, department_code, active
       FROM routing_rule WHERE category_code = ? AND line_code = ?`,
      categoryCode,
      lineCode,
    )
  ).map((r) => ({
    id: r.id as number,
    categoryCode: r.category_code as string,
    lineCode: r.line_code as string,
    processId: (r.process_id as number | null) ?? null,
    departmentCode: r.department_code as string,
    active: r.active === 1,
  }));
}

interface DepartmentRow {
  code: string;
  name_ko: string;
  display_code: string | null;
  successor_code: string | null;
}

/** All departments (≈10 rows) in one query; label / successor / alias lookups then run in memory. */
async function departments(): Promise<Map<string, DepartmentRow>> {
  const rows = (await db.all("SELECT code, name_ko, display_code, successor_code FROM department")) as unknown as DepartmentRow[];
  return new Map(rows.map((d) => [d.code, d]));
}

function labelOf(deps: Map<string, DepartmentRow>, code: string): string {
  const d = deps.get(code);
  return d ? `${d.display_code ?? d.code} · ${d.name_ko}` : code;
}

function effectiveOf(deps: Map<string, DepartmentRow>, code: string): string {
  let current = code;
  for (let i = 0; i < 5; i++) {
    const next = deps.get(current)?.successor_code;
    if (!next) return current;
    current = next;
  }
  return current;
}

/** "PC&L · 물류" — display label of a department code. */
export async function departmentLabel(code: string): Promise<string> {
  return labelOf(await departments(), code);
}

/** Department code → display label, for mapping many rows with a single query. */
export async function departmentLabelMap(): Promise<Map<string, string>> {
  const deps = await departments();
  return new Map([...deps.keys()].map((c) => [c, labelOf(deps, c)]));
}

/** Current operational department for a (possibly pre-v3) department code. */
export async function effectiveDepartment(code: string): Promise<string> {
  return effectiveOf(await departments(), code);
}

/** All department codes whose events belong to `code` today (itself + legacy codes mapped to it). */
export async function departmentAliases(code: string): Promise<string[]> {
  const deps = await departments();
  return [...deps.keys()].filter((c) => effectiveOf(deps, c) === code);
}

async function responsibility(
  departmentCode: string,
  matchedBy: Responsibility["matchedBy"],
  routingRuleId: number | null,
): Promise<Responsibility> {
  const deps = await departments();
  return {
    departmentCode,
    effectiveDepartmentCode: effectiveOf(deps, departmentCode),
    departmentName: deps.get(departmentCode)?.name_ko ?? departmentCode,
    departmentLabel: labelOf(deps, departmentCode),
    matchedBy,
    routingRuleId,
  };
}

/** Line + Process + Category → responsible department (deterministic, see src/lib/routing.ts). */
export async function resolveResponsibility(lineCode: string, processId: number, categoryCode: string): Promise<Responsibility> {
  const cat = (await db.get("SELECT default_department FROM category WHERE code = ?", categoryCode)) as
    | { default_department: string }
    | undefined;
  if (!cat) throw new AndonError(400, "이상 유형 선택이 올바르지 않습니다.", "INVALID_CATEGORY");
  const r = resolveDepartment(await loadRules(categoryCode, lineCode), {
    lineCode,
    processId,
    categoryCode,
    categoryDefaultDepartment: cat.default_department,
  });
  return responsibility(r.departmentCode, r.matchedBy, r.routingRuleId);
}

/** Responsibility of a stored event: the department recorded at creation (never re-routed later). */
export async function eventResponsibility(eventId: string): Promise<Responsibility | null> {
  const r = (await db.get("SELECT department_code, routing_rule_id FROM andon_event WHERE id = ?", eventId)) as
    | { department_code: string; routing_rule_id: number | null }
    | undefined;
  if (!r) return null;
  let matchedBy: Responsibility["matchedBy"] = "CATEGORY_DEFAULT";
  if (await db.get("SELECT 1 FROM andon_event_department WHERE event_id = ?", eventId)) return responsibility(r.department_code, "GAP_LEADER_CALL", null);
  if (r.routing_rule_id != null) {
    const rule = (await db.get("SELECT process_id FROM routing_rule WHERE id = ?", r.routing_rule_id)) as
      | { process_id: number | null }
      | undefined;
    matchedBy = rule?.process_id != null ? "LINE_PROCESS_CATEGORY" : "LINE_CATEGORY";
  }
  return responsibility(r.department_code, matchedBy, r.routing_rule_id);
}

const USER_SELECT = `
SELECT u.id, u.name, u.department_code, u.role, u.active, r.can_respond
FROM app_user u JOIN role r ON r.code = u.role`;

function toCandidate(r: Row): ResponderCandidate {
  return {
    id: r.id as number,
    name: r.name as string,
    departmentCode: r.department_code as string,
    role: r.role as string,
    active: r.active === 1,
    roleCanRespond: r.can_respond === 1,
  };
}

const summary = (u: ResponderCandidate): ResponderSummary => ({
  id: u.id,
  name: u.name,
  role: u.role as RoleCode,
  departmentCode: u.departmentCode,
});

/**
 * Everyone who may ACK / ACTION / CLOSE events of this department: active users of the (current)
 * department whose role can respond. A newly registered RESPONDER appears here immediately.
 */
export async function eligibleResponders(eventDepartmentCode: string | string[]): Promise<ResponderSummary[]> {
  const deps = await departments();
  const codes = [...new Set((Array.isArray(eventDepartmentCode) ? eventDepartmentCode : [eventDepartmentCode]).map((c) => effectiveOf(deps, c)))];
  return (
    await db.all(
      `${USER_SELECT} WHERE u.active = 1 AND r.can_respond = 1 AND u.department_code IN (${codes.map(() => "?").join(",")}) ORDER BY r.sort_order, u.id`,
      ...codes,
    )
  ).map((r) => summary(toCandidate(r)));
}

/**
 * Responsible departments whose EVERY member receives the initial ANDON notification — team leader
 * included, any role that may respond (plant decision 2026-10-06: HSE, ME, MT, QC, PC&L). Other departments
 * (UAP) notify their RESPONDER accounts only.
 */
export const ALL_MEMBER_NOTIFY_DEPARTMENTS: readonly string[] = ["HSE", "ME", "MT", "QC", "PCL", "SQA"];

/**
 * Receivers of the initial notification of a department (escalation comes later, with Reaction Rules):
 * all members that may respond for ALL_MEMBER_NOTIFY_DEPARTMENTS, otherwise RESPONDER accounts.
 * The KakaoTalk address comes ONLY from a verified, active user_notification_channel row — never from
 * app_user.kakao_id, which is a manually typed contact reference and not a verified recipient.
 */
export async function primaryRecipients(
  eventDepartmentCode: string,
): Promise<(ResponderSummary & { kakaoRecipientId: string | null })[]> {
  const dept = await effectiveDepartment(eventDepartmentCode);
  return (
    await db.all(
      `SELECT u.id, u.name, u.department_code, u.role,
              (SELECT c.recipient_id FROM user_notification_channel c
               WHERE c.user_id = u.id AND c.provider = 'KAKAO' AND c.verified = 1 AND c.active = 1
               ORDER BY c.id LIMIT 1) AS kakao_recipient_id
       FROM app_user u JOIN role r ON r.code = u.role
       WHERE u.active = 1 AND u.department_code = ?1
         AND (u.role = 'RESPONDER' OR (?2 = 1 AND r.can_respond = 1))
       ORDER BY u.id`,
      dept,
      ALL_MEMBER_NOTIFY_DEPARTMENTS.includes(dept) ? 1 : 0,
    )
  ).map((r) => ({
    id: r.id as number,
    name: r.name as string,
    role: r.role as RoleCode,
    departmentCode: r.department_code as string,
    kakaoRecipientId: (r.kakao_recipient_id as string | null) ?? null,
  }));
}

export interface ResponderIdentity {
  userId?: number | null;
  /** Server-internal callers only (demo seeder). HTTP requests identify the responder by session. */
  userName?: string | null;
}

/**
 * Server-side responder validation. The responder must exist, be active, have a role that may
 * respond, and belong to the event's (current) responsible department. Throws AndonError otherwise.
 */
export async function validateResponder(identity: ResponderIdentity, eventDepartmentCode: string | string[]): Promise<ResponderSummary> {
  let row: Row | undefined;
  if (identity.userId != null) {
    if (!Number.isInteger(identity.userId) || identity.userId <= 0) {
      throw new AndonError(400, "등록되지 않은 담당자입니다.", "UNKNOWN_RESPONDER");
    }
    row = await db.get(`${USER_SELECT} WHERE u.id = ?`, identity.userId);
  } else if (identity.userName && identity.userName.trim()) {
    const rows = await db.all(`${USER_SELECT} WHERE u.name = ?`, identity.userName.trim());
    if (rows.length > 1) throw new AndonError(400, "같은 이름의 사용자가 여러 명입니다.", "AMBIGUOUS_RESPONDER");
    row = rows[0];
  } else {
    throw new AndonError(400, "담당자를 선택하세요.", "USER_REQUIRED");
  }
  if (!row) throw new AndonError(400, "등록되지 않은 담당자입니다.", "UNKNOWN_RESPONDER");

  const user = toCandidate(row);
  const deps = await departments();
  // An event of a multi-department call (v9) may be handled by a member of ANY of its departments.
  const codes = (Array.isArray(eventDepartmentCode) ? eventDepartmentCode : [eventDepartmentCode]).map((c) => effectiveOf(deps, c));
  const problems = codes.map((c) => responderProblem(user, c));
  const problem = problems.includes(null) ? null : (problems.find((x) => x !== "WRONG_DEPARTMENT") ?? "WRONG_DEPARTMENT");
  if (problem === "INACTIVE") throw new AndonError(403, `${user.name}: 비활성(사용 중지)된 계정입니다.`, "INACTIVE_RESPONDER");
  if (problem === "ROLE_NOT_ALLOWED")
    throw new AndonError(403, `${user.name}: 조치 권한이 없는 역할입니다 (${user.role}).`, "ROLE_NOT_ALLOWED");
  if (problem === "WRONG_DEPARTMENT")
    throw new AndonError(403, `${user.name}: 이 ANDON의 담당 부서(${codes.map((c) => labelOf(deps, c)).join(", ")}) 소속이 아닙니다.`, "WRONG_DEPARTMENT");
  return summary(user);
}
