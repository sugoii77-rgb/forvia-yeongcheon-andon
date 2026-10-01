// Deterministic routing: (line, process, category) → responsible department.
// Pure functions, no database access — loaded rules are passed in, so this is unit-testable.
//
// Rules always name a category; they can be narrowed to a line, or to a line + process.
// The most specific ACTIVE rule wins; ties are impossible because the DB has a unique index on
// (category, line, process). If no rule matches, the category's default department is used.
//
//   1. LINE_PROCESS_CATEGORY   rule.category = c AND rule.line = l AND rule.process = p
//   2. LINE_CATEGORY           rule.category = c AND rule.line = l AND rule.process IS NULL
//   3. CATEGORY_DEFAULT        category.default_department
//
// Rules without a line (category-wide) are not stored as rules: that is the category default.
import type { RoutingMatch } from "./domain.ts";

export interface RoutingRule {
  id: number;
  categoryCode: string;
  lineCode: string | null;
  processId: number | null;
  departmentCode: string;
  active: boolean;
}

export interface RoutingContext {
  lineCode: string;
  processId: number;
  categoryCode: string;
  /** category.default_department */
  categoryDefaultDepartment: string;
}

export interface RoutingResult {
  departmentCode: string;
  matchedBy: RoutingMatch;
  routingRuleId: number | null;
}

export function resolveDepartment(rules: readonly RoutingRule[], ctx: RoutingContext): RoutingResult {
  let processMatch: RoutingRule | null = null;
  let lineMatch: RoutingRule | null = null;
  for (const r of rules) {
    if (!r.active || r.categoryCode !== ctx.categoryCode || r.lineCode !== ctx.lineCode) continue;
    if (r.processId === ctx.processId) {
      // unique index guarantees at most one; keep lowest id defensively so the result never depends on order
      if (!processMatch || r.id < processMatch.id) processMatch = r;
    } else if (r.processId === null) {
      if (!lineMatch || r.id < lineMatch.id) lineMatch = r;
    }
  }
  if (processMatch) return { departmentCode: processMatch.departmentCode, matchedBy: "LINE_PROCESS_CATEGORY", routingRuleId: processMatch.id };
  if (lineMatch) return { departmentCode: lineMatch.departmentCode, matchedBy: "LINE_CATEGORY", routingRuleId: lineMatch.id };
  return { departmentCode: ctx.categoryDefaultDepartment, matchedBy: "CATEGORY_DEFAULT", routingRuleId: null };
}

export interface ResponderCandidate {
  id: number;
  name: string;
  departmentCode: string;
  role: string;
  active: boolean;
  /** role.can_respond */
  roleCanRespond: boolean;
}

export type EligibilityProblem = "INACTIVE" | "ROLE_NOT_ALLOWED" | "WRONG_DEPARTMENT";

/** Why a user may not respond to an event of `departmentCode` (null = eligible). */
export function responderProblem(user: ResponderCandidate, departmentCode: string): EligibilityProblem | null {
  if (!user.active) return "INACTIVE";
  if (!user.roleCanRespond) return "ROLE_NOT_ALLOWED";
  if (user.departmentCode !== departmentCode) return "WRONG_DEPARTMENT";
  return null;
}
