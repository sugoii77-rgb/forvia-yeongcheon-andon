// Initial master data for Yeongcheon plant.
// Inserted with INSERT OR IGNORE on DB start-up, so edits made in the DB (or with
// `npm run masterdata`) are never overwritten. Changing a value here does NOT change an existing DB.
import type { RoleCode } from "../domain.ts";
import { YEONGCHEON_SHIFT_RULE, type ShiftRule } from "../shiftSchedule.ts";

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

/**
 * Operational departments = WHO is responsible (not the issue category). Since schema v3.
 * code: stable internal id; displayCode: shown to users ("PC&L").
 */
export const DEPARTMENTS = [
  { code: "ME", displayCode: "ME", nameKo: "생산기술", nameEn: "Production Engineering / Manufacturing Engineering", sortOrder: 1 },
  { code: "MT", displayCode: "MT", nameKo: "보전", nameEn: "Maintenance", sortOrder: 2 },
  { code: "UAP", displayCode: "UAP", nameKo: "생산", nameEn: "Production", sortOrder: 3 },
  { code: "QC", displayCode: "QC", nameKo: "품질", nameEn: "Quality", sortOrder: 4 },
  { code: "PCL", displayCode: "PC&L", nameKo: "물류", nameEn: "Production Control & Logistics", sortOrder: 5 },
  // plant table 2026-10-06: 단품불량 → SQA (supplier quality, part of the quality team, called separately)
  { code: "SQA", displayCode: "SQA", nameKo: "외주품질", nameEn: "Supplier Quality Assurance", sortOrder: 6 },
];

/**
 * Pre-v3 department codes → current department (schema v3 migration). Old departments stay in the
 * table as inactive rows with successor_code, so historical events keep their original code.
 * EHS → UAP is a prototype decision (no safety department among the five) — confirm with the plant.
 */
/**
 * Situations a GAP leader picks when calling (plant table 2026-10-06, "상황 → 호출"). Picking one adds its
 * call target (department; SV = the line's supervisor) and suggests the issue category. Code-defined
 * (not stored in the DB); events store the chosen codes (andon_event.situations, v9).
 */
export const CALL_SITUATIONS: { code: string; nameKo: string; target: string; category: string }[] = [
  { code: "QC_MISSING", nameKo: "누락", target: "QC", category: "QUALITY" },
  { code: "QC_WELD", nameKo: "용접불량", target: "QC", category: "QUALITY" },
  { code: "QC_APPEARANCE", nameKo: "외관불량", target: "QC", category: "QUALITY" },
  { code: "QC_LEAK_NG", nameKo: "Leak NG", target: "QC", category: "QUALITY" },
  { code: "QC_STANDARD", nameKo: "검사기준 불명확", target: "QC", category: "QUALITY" },
  { code: "QC_GAUGE", nameKo: "검사구 문제", target: "QC", category: "QUALITY" },
  { code: "SQA_PART", nameKo: "단품불량", target: "SQA", category: "QUALITY" },
  { code: "MT_STOP", nameKo: "설비 정지", target: "MT", category: "MAINTENANCE" },
  { code: "MT_ROBOT", nameKo: "Robot Fault", target: "MT", category: "MAINTENANCE" },
  { code: "MT_NUTRUNNER", nameKo: "Nutrunner Fault", target: "MT", category: "MAINTENANCE" },
  { code: "MT_LEAK_TESTER", nameKo: "Leak Tester NG", target: "MT", category: "MAINTENANCE" },
  { code: "MT_SENSOR", nameKo: "Sensor Fault", target: "MT", category: "MAINTENANCE" },
  { code: "ME_CONDITION", nameKo: "공정조건 이상", target: "ME", category: "PRODUCTION" },
  { code: "ME_CYCLE_TIME", nameKo: "싸이클타임 불량", target: "ME", category: "PRODUCTION" },
  { code: "ME_TOOLING", nameKo: "치공구 문제", target: "ME", category: "PRODUCTION" },
  { code: "ME_NEW_ISSUE", nameKo: "신규 문제 원인 미확정", target: "ME", category: "PRODUCTION" },
  { code: "PCL_SHORTAGE", nameKo: "자재 부족", target: "PCL", category: "MATERIAL" },
  { code: "PCL_WRONG_INPUT", nameKo: "잘못 투입", target: "PCL", category: "MATERIAL" },
  { code: "PCL_FIFO", nameKo: "FIFO 문제", target: "PCL", category: "MATERIAL" },
  { code: "SV_MANPOWER", nameKo: "인원 부족", target: "SV", category: "PRODUCTION" },
  { code: "SV_METHOD", nameKo: "작업방법 문제", target: "SV", category: "PRODUCTION" },
];

export const LEGACY_DEPARTMENT_SUCCESSORS: Record<string, string> = {
  QUALITY: "QC",
  MAINTENANCE: "MT",
  PRODUCTION: "UAP",
  LOGISTICS: "PCL",
  EHS: "UAP",
};

/**
 * Issue categories = WHAT kind of problem. defaultDepartment = routing for the whole category unless a
 * routing rule overrides it. No category routes to ME yet (no business rule defined) — add routing
 * rules for ME when the plant defines them. SAFETY → UAP: prototype decision, confirm with the plant.
 */
export const CATEGORIES = [
  { code: "QUALITY", nameKo: "품질", nameEn: "Quality", defaultDepartment: "QC", sortOrder: 1 },
  { code: "MAINTENANCE", nameKo: "설비", nameEn: "Maintenance", defaultDepartment: "MT", sortOrder: 2 },
  { code: "PRODUCTION", nameKo: "생산", nameEn: "Production", defaultDepartment: "UAP", sortOrder: 3 },
  { code: "MATERIAL", nameKo: "자재/물류", nameEn: "Material / Logistics", defaultDepartment: "PCL", sortOrder: 4 },
  { code: "SAFETY", nameKo: "안전", nameEn: "Safety", defaultDepartment: "UAP", sortOrder: 5 },
  { code: "OTHER", nameKo: "기타", nameEn: "Other", defaultDepartment: "UAP", sortOrder: 6 },
];

/**
 * UAP areas (production areas) of the Yeongcheon plant — source: workbook
 * "모바일 안돈시스템(261001) QC.xlsx", sheets 개인정보 (column 부서-1) and UAP(Line 구분). Since schema v6.
 */
export const UAP_AREAS = [
  { code: "AP-1", name: "AP-1", sortOrder: 1 },
  { code: "AP-2", name: "AP-2", sortOrder: 2 },
  { code: "AQ-1", name: "AQ-1", sortOrder: 3 },
  { code: "AQ-2", name: "AQ-2", sortOrder: 4 },
  { code: "AQ-3", name: "AQ-3", sortOrder: 5 },
  { code: "BENDING", name: "BENDING", sortOrder: 6 },
  { code: "RESO", name: "RESO", sortOrder: 7 },
];

/**
 * Lines. The first three are the PROTOTYPE demo lines (no UAP area; demo events and tests use them).
 * The others are the REAL Yeongcheon UAP lines from the workbook (schema v6); `name` is spelled exactly
 * as in the workbook (it is the key the assignment import matches on). Codes are stable internal ids.
 */
export const LINES: { code: string; name: string; plantCode: string; sortOrder: number; uapAreaCode?: string }[] = [
  { code: "TGDI1", name: "T-GDI 1", plantCode: "YC", sortOrder: 1 },
  { code: "TGDI2", name: "T-GDI 2", plantCode: "YC", sortOrder: 2 },
  { code: "MUF1", name: "Muffler 1", plantCode: "YC", sortOrder: 3 },
  ...(
    [
      ["AP-1", [["AP1-MAIN1", "Main #1"], ["AP1-MAIN2", "Main #2"], ["AP1-FRT", "FRT"], ["AP1-NX4-CTR", "NX4 CTR"], ["AP1-NX4-MAIN", "NX4 MAIN"], ["AP1-NX4-CTR2", "NX4 CTR #2"]]],
      ["AP-2", [["AP2-CTR1", "CTR #1"], ["AP2-CTR2", "CTR #2"], ["AP2-MAIN3", "Main #3"], ["AP2-JX-ASSY", "JX ASSY"], ["AP2-JX-SUB", "JX SUB"], ["AP2-JX-LAMBDA-FRT", "JX LAMBDA FRT"]]],
      ["AQ-1", [["AQ1-NUI1", "NU-I #1"], ["AQ1-NUI1-EXMANI", "NU-I #1 EXMANI"], ["AQ1-GPF", "GPF"], ["AQ1-NUI2", "NU-I #2"], ["AQ1-NUI2-EXMANI", "NU-I #2 EXMANI"]]],
      ["AQ-2", [["AQ2-KAPPA16", "KAPPA 1.6"], ["AQ2-TURBO2-EU7", "TURBO #2 EU7"], ["AQ2-EXMANI1", "EXMANI #1"], ["AQ2-EXMANI2", "EXMANI #2"], ["AQ2-GAMMA2", "GAMMA #2"], ["AQ2-TURBO1", "TURBO#1"]]],
      ["AQ-3", [["AQ3-GAMMA3", "GAMMA #3"], ["AQ3-UCC", "UCC"], ["AQ3-KAPPA-UCC", "KAPPA UCC"], ["AQ3-R-ENG", "R-ENG"], ["AQ3-STUFFING", "STUFFING"]]],
      ["BENDING", [["BND-HE-BENDING", "HE BENDING"], ["BND-PIPE-CUTTING", "PIPE CUTTING"], ["BND-CE-BENDING", "CE BENDING"]]],
      ["RESO", [["RESO-LOCKSEAM", "LOCKSEAM"], ["RESO-QX", "QX RESO"], ["RESO-CTR", "CTR RESO"], ["RESO-SX2", "SX2 RESO"], ["RESO-JX-NX4", "JX/NX4 RESO"]]],
    ] as const
  ).flatMap(([area, lines], ai) =>
    lines.map(([code, name], li) => ({ code, name, plantCode: "YC", sortOrder: 100 * (ai + 1) + li + 1, uapAreaCode: area })),
  ),
];

/**
 * The real lines have NO process master yet (pending plant input). andon_event.process_id is required,
 * so each real line gets ONE clearly marked placeholder process (process.placeholder = 1). It is not a
 * real process: replace it when the plant provides the Line → Process master.
 */
export const PLACEHOLDER_PROCESS_NAME = "공정 미지정";

/**
 * Shift TEAMS A and B (the GAP leaders' shift assignment in the workbook). A team has no fixed clock
 * time — teams rotate DAY / NIGHT weekly — so shift.start_time / end_time stay NULL; the DAY / NIGHT
 * times and the weekly rotation are in shift_schedule (SHIFT_SCHEDULES below, schema v7).
 */
export const SHIFTS = [
  { code: "A", nameKo: "A조", sortOrder: 1 },
  { code: "B", nameKo: "B조", sortOrder: 2 },
];

/**
 * Shift schedule rule per plant (schema v7) — confirmed by the plant 2026-10-02: 12-hour shifts,
 * DAY 08:00 / NIGHT 20:00, Asia/Seoul, A/B swap DAY/NIGHT weekly at the Monday 08:00 DAY shift.
 * The ANCHOR (which team has DAY in a given week) is not known yet and is NOT seeded.
 */
export const SHIFT_SCHEDULES: { plantCode: string; rule: ShiftRule }[] = [{ plantCode: "YC", rule: YEONGCHEON_SHIFT_RULE }];

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
  { categoryCode: "OTHER", lineCode: "TGDI1", processName: "Packing", departmentCode: "PCL", note: "포장 라벨/박스 문제는 물류 담당" },
];

// Demo users (fictional) without login credentials: they exist for demo history and the seeder.
// Real people register themselves (role RESPONDER) via /register; roles are changed by an administrator.
export const USERS: { name: string; departmentCode: string; role: RoleCode; active: boolean }[] = [
  { name: "품질 담당 A", departmentCode: "QC", role: "RESPONDER", active: true },
  { name: "품질 담당 B", departmentCode: "QC", role: "RESPONDER", active: true },
  { name: "생산 반장", departmentCode: "UAP", role: "RESPONDER", active: true },
  { name: "보전 담당", departmentCode: "MT", role: "RESPONDER", active: true },
  { name: "물류 담당", departmentCode: "PCL", role: "RESPONDER", active: true },
  { name: "안전 담당", departmentCode: "UAP", role: "RESPONDER", active: true },
  { name: "생산 팀장", departmentCode: "UAP", role: "SUPERVISOR", active: true },
  { name: "품질 GAP 리더", departmentCode: "QC", role: "GAP_LEADER", active: true },
  { name: "T-GDI 1 작업자", departmentCode: "UAP", role: "OPERATOR", active: true },
  // Example of a deactivated account (left the company): kept for history, cannot respond.
  { name: "품질 담당 C (퇴직)", departmentCode: "QC", role: "RESPONDER", active: false },
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
