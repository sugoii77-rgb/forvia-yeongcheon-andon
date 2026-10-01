// Responsibility & identity: which department owns an ANDON, who may respond, who is notified.
// All routing decisions are made here (server side). UI components never decide routing.
import type { ResponderSummary, Responsibility, RoleCode } from "../domain.ts";
import { resolveDepartment, responderProblem, type ResponderCandidate, type RoutingRule } from "../routing.ts";
import { getDb } from "./db.ts";
import { AndonError } from "./errors.ts";

type Row = Record<string, unknown>;

function loadRules(categoryCode: string, lineCode: string): RoutingRule[] {
  return getDb()
    .prepare(
      `SELECT id, category_code, line_code, process_id, department_code, active
       FROM routing_rule WHERE category_code = ? AND line_code = ?`,
    )
    .all(categoryCode, lineCode)
    .map((r) => ({
      id: r.id as number,
      categoryCode: r.category_code as string,
      lineCode: r.line_code as string,
      processId: (r.process_id as number | null) ?? null,
      departmentCode: r.department_code as string,
      active: r.active === 1,
    }));
}

function departmentName(code: string): string {
  const r = getDb().prepare("SELECT name_ko FROM department WHERE code = ?").get(code) as { name_ko: string } | undefined;
  return r?.name_ko ?? code;
}

/** Line + Process + Category → responsible department (deterministic, see src/lib/routing.ts). */
export function resolveResponsibility(lineCode: string, processId: number, categoryCode: string): Responsibility {
  const cat = getDb().prepare("SELECT default_department FROM category WHERE code = ?").get(categoryCode) as
    | { default_department: string }
    | undefined;
  if (!cat) throw new AndonError(400, "이상 유형 선택이 올바르지 않습니다.", "INVALID_CATEGORY");
  const r = resolveDepartment(loadRules(categoryCode, lineCode), {
    lineCode,
    processId,
    categoryCode,
    categoryDefaultDepartment: cat.default_department,
  });
  return { ...r, departmentName: departmentName(r.departmentCode) };
}

/** Responsibility of a stored event: the department recorded at creation (never re-routed later). */
export function eventResponsibility(eventId: string): Responsibility | null {
  const r = getDb()
    .prepare("SELECT department_code, routing_rule_id FROM andon_event WHERE id = ?")
    .get(eventId) as { department_code: string; routing_rule_id: number | null } | undefined;
  if (!r) return null;
  let matchedBy: Responsibility["matchedBy"] = "CATEGORY_DEFAULT";
  if (r.routing_rule_id != null) {
    const rule = getDb().prepare("SELECT process_id FROM routing_rule WHERE id = ?").get(r.routing_rule_id) as
      | { process_id: number | null }
      | undefined;
    matchedBy = rule?.process_id != null ? "LINE_PROCESS_CATEGORY" : "LINE_CATEGORY";
  }
  return {
    departmentCode: r.department_code,
    departmentName: departmentName(r.department_code),
    matchedBy,
    routingRuleId: r.routing_rule_id,
  };
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

/** Everyone who may ACK / ACTION / CLOSE events of this department. */
export function eligibleResponders(departmentCode: string): ResponderSummary[] {
  return getDb()
    .prepare(`${USER_SELECT} WHERE u.active = 1 AND r.can_respond = 1 AND u.department_code = ? ORDER BY r.sort_order, u.id`)
    .all(departmentCode)
    .map((r) => summary(toCandidate(r)));
}

/** First responders of a department: receive the initial notification (escalation roles come later). */
export function primaryRecipients(departmentCode: string): (ResponderSummary & { kakaoId: string | null })[] {
  return getDb()
    .prepare(
      `SELECT u.id, u.name, u.department_code, u.role, u.kakao_id FROM app_user u
       WHERE u.active = 1 AND u.role = 'RESPONDER' AND u.department_code = ? ORDER BY u.id`,
    )
    .all(departmentCode)
    .map((r) => ({
      id: r.id as number,
      name: r.name as string,
      role: r.role as RoleCode,
      departmentCode: r.department_code as string,
      kakaoId: (r.kakao_id as string | null) ?? null,
    }));
}

export interface ResponderIdentity {
  userId?: number | null;
  userName?: string | null;
}

/**
 * Server-side responder validation. The responder must exist, be active, have a role that may
 * respond, and belong to the event's responsible department. Throws AndonError otherwise.
 */
export function validateResponder(identity: ResponderIdentity, departmentCode: string): ResponderSummary {
  const db = getDb();
  let row: Row | undefined;
  if (identity.userId != null) {
    if (!Number.isInteger(identity.userId) || identity.userId <= 0) {
      throw new AndonError(400, "등록되지 않은 담당자입니다.", "UNKNOWN_RESPONDER");
    }
    row = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(identity.userId);
    // If both are sent they must refer to the same person.
    if (row && identity.userName && identity.userName.trim() !== row.name) {
      throw new AndonError(400, "담당자 정보가 일치하지 않습니다.", "RESPONDER_MISMATCH");
    }
  } else if (identity.userName && identity.userName.trim()) {
    row = db.prepare(`${USER_SELECT} WHERE u.name = ?`).get(identity.userName.trim());
  } else {
    throw new AndonError(400, "담당자를 선택하세요.", "USER_REQUIRED");
  }
  if (!row) throw new AndonError(400, "등록되지 않은 담당자입니다.", "UNKNOWN_RESPONDER");

  const user = toCandidate(row);
  const problem = responderProblem(user, departmentCode);
  if (problem === "INACTIVE") throw new AndonError(403, `${user.name}: 비활성(사용 중지)된 담당자입니다.`, "INACTIVE_RESPONDER");
  if (problem === "ROLE_NOT_ALLOWED")
    throw new AndonError(403, `${user.name}: 조치 권한이 없는 역할입니다 (${user.role}).`, "ROLE_NOT_ALLOWED");
  if (problem === "WRONG_DEPARTMENT")
    throw new AndonError(
      403,
      `${user.name}: 이 ANDON의 담당 부서(${departmentName(departmentCode)}) 소속이 아닙니다.`,
      "WRONG_DEPARTMENT",
    );
  return summary(user);
}
