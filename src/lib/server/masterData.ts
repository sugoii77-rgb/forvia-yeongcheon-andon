// Initial master data for Yeongcheon plant.
// Inserted with INSERT OR IGNORE on DB start-up, so edits made in the DB (or with
// `npm run masterdata`) are never overwritten. Changing a value here does NOT change an existing DB.
import type { RoleCode } from "../domain.ts";

export const PLANTS = [{ code: "YC", name: "Yeongcheon", nameKo: "영천" }];
/** Plant name stored on each event (single-plant prototype). */
export const PLANT = PLANTS[0].name;

export const ROLES: {
  code: RoleCode;
  nameKo: string;
  nameEn: string;
  canRespond: boolean;
  /** Future escalation level (null = not an escalation target). Not used yet. */
  escalationLevel: number | null;
  sortOrder: number;
}[] = [
  { code: "OPERATOR", nameKo: "작업자", nameEn: "Operator", canRespond: false, escalationLevel: null, sortOrder: 1 },
  { code: "RESPONDER", nameKo: "담당자", nameEn: "Responder", canRespond: true, escalationLevel: 0, sortOrder: 2 },
  { code: "GAP_LEADER", nameKo: "GAP 리더", nameEn: "GAP Leader", canRespond: true, escalationLevel: 1, sortOrder: 3 },
  { code: "SUPERVISOR", nameKo: "감독자", nameEn: "Supervisor", canRespond: true, escalationLevel: 2, sortOrder: 4 },
  { code: "ENGINEER", nameKo: "엔지니어", nameEn: "Engineer", canRespond: true, escalationLevel: 2, sortOrder: 5 },
  { code: "PLANT_MANAGER", nameKo: "공장장", nameEn: "Plant Manager", canRespond: true, escalationLevel: 3, sortOrder: 6 },
];

export const DEPARTMENTS = [
  { code: "QUALITY", nameKo: "품질", nameEn: "Quality" },
  { code: "PRODUCTION", nameKo: "생산", nameEn: "Production" },
  { code: "MAINTENANCE", nameKo: "보전", nameEn: "Maintenance" },
  { code: "LOGISTICS", nameKo: "물류", nameEn: "Logistics" },
  { code: "EHS", nameKo: "안전환경", nameEn: "EHS / Safety" },
];

/** defaultDepartment = routing for the whole category unless a routing rule overrides it. */
export const CATEGORIES = [
  { code: "QUALITY", nameKo: "품질", nameEn: "Quality", defaultDepartment: "QUALITY", sortOrder: 1 },
  { code: "MAINTENANCE", nameKo: "설비", nameEn: "Maintenance", defaultDepartment: "MAINTENANCE", sortOrder: 2 },
  { code: "PRODUCTION", nameKo: "생산", nameEn: "Production", defaultDepartment: "PRODUCTION", sortOrder: 3 },
  { code: "MATERIAL", nameKo: "자재/물류", nameEn: "Material / Logistics", defaultDepartment: "LOGISTICS", sortOrder: 4 },
  { code: "SAFETY", nameKo: "안전", nameEn: "Safety", defaultDepartment: "EHS", sortOrder: 5 },
  { code: "OTHER", nameKo: "기타", nameEn: "Other", defaultDepartment: "PRODUCTION", sortOrder: 6 },
];

export const LINES = [
  { code: "TGDI1", name: "T-GDI 1", plantCode: "YC", sortOrder: 1 },
  { code: "TGDI2", name: "T-GDI 2", plantCode: "YC", sortOrder: 2 },
  { code: "MUF1", name: "Muffler 1", plantCode: "YC", sortOrder: 3 },
];

export const PROCESSES: { lineCode: string; name: string; sortOrder: number }[] = [
  { lineCode: "TGDI1", name: "WCC Canning", sortOrder: 1 },
  { lineCode: "TGDI1", name: "WCC Welding", sortOrder: 2 },
  { lineCode: "TGDI1", name: "Leak Test", sortOrder: 3 },
  { lineCode: "TGDI1", name: "WCC Final Inspection", sortOrder: 4 },
  { lineCode: "TGDI1", name: "Packing", sortOrder: 5 },
  { lineCode: "TGDI2", name: "WCC Canning", sortOrder: 1 },
  { lineCode: "TGDI2", name: "WCC Welding", sortOrder: 2 },
  { lineCode: "TGDI2", name: "Leak Test", sortOrder: 3 },
  { lineCode: "TGDI2", name: "WCC Final Inspection", sortOrder: 4 },
  { lineCode: "MUF1", name: "Pipe Bending", sortOrder: 1 },
  { lineCode: "MUF1", name: "Muffler Welding", sortOrder: 2 },
  { lineCode: "MUF1", name: "Final Inspection", sortOrder: 3 },
];

/**
 * Routing overrides (more specific than the category default). Demo rule:
 * "기타" issues at T-GDI 1 Packing (label printer, boxes) go to Logistics instead of Production.
 */
export const ROUTING_RULES: { categoryCode: string; lineCode: string; processName: string | null; departmentCode: string; note: string }[] = [
  { categoryCode: "OTHER", lineCode: "TGDI1", processName: "Packing", departmentCode: "LOGISTICS", note: "포장 라벨/박스 문제는 물류 담당" },
];

// Demo users (fictional). Phase 1 has no login; the responder picks a name, the server validates it.
export const USERS: { name: string; departmentCode: string; role: RoleCode; active: boolean }[] = [
  { name: "품질 담당 A", departmentCode: "QUALITY", role: "RESPONDER", active: true },
  { name: "품질 담당 B", departmentCode: "QUALITY", role: "RESPONDER", active: true },
  { name: "생산 반장", departmentCode: "PRODUCTION", role: "RESPONDER", active: true },
  { name: "보전 담당", departmentCode: "MAINTENANCE", role: "RESPONDER", active: true },
  { name: "물류 담당", departmentCode: "LOGISTICS", role: "RESPONDER", active: true },
  { name: "안전 담당", departmentCode: "EHS", role: "RESPONDER", active: true },
  { name: "생산 팀장", departmentCode: "PRODUCTION", role: "SUPERVISOR", active: true },
  { name: "품질 GAP 리더", departmentCode: "QUALITY", role: "GAP_LEADER", active: true },
  { name: "T-GDI 1 작업자", departmentCode: "PRODUCTION", role: "OPERATOR", active: true },
  // Example of a deactivated account (left the company): kept for history, cannot respond.
  { name: "품질 담당 C (퇴직)", departmentCode: "QUALITY", role: "RESPONDER", active: false },
];

/**
 * Escalation model — PREPARED, NOT ACTIVE. The policy is inserted inactive and its thresholds are
 * left empty (NULL): they must be configured in the DB before escalation is implemented/enabled.
 * Order of targets: RESPONDER (initial notification) → GAP_LEADER → SUPERVISOR / ENGINEER → PLANT_MANAGER.
 */
export const ESCALATION_POLICIES = [{ code: "DEFAULT", name: "기본 에스컬레이션 (미사용)" }];
export const ESCALATION_STEPS: { policyCode: string; stepNo: number; targetRole: RoleCode }[] = [
  { policyCode: "DEFAULT", stepNo: 1, targetRole: "GAP_LEADER" },
  { policyCode: "DEFAULT", stepNo: 2, targetRole: "SUPERVISOR" },
  { policyCode: "DEFAULT", stepNo: 2, targetRole: "ENGINEER" },
  { policyCode: "DEFAULT", stepNo: 3, targetRole: "PLANT_MANAGER" },
];
