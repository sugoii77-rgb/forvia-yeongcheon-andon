// Initial master data for Yeongcheon plant.
// Inserted with INSERT OR IGNORE on DB start-up, so edits made directly in the DB
// are never overwritten. To change master data later, edit the DB tables
// (a settings screen is a pending task — see PROJECT.md).

export const PLANT = "Yeongcheon";

export const DEPARTMENTS = [
  { code: "QUALITY", nameKo: "품질", nameEn: "Quality" },
  { code: "PRODUCTION", nameKo: "생산", nameEn: "Production" },
  { code: "MAINTENANCE", nameKo: "보전", nameEn: "Maintenance" },
  { code: "LOGISTICS", nameKo: "물류", nameEn: "Logistics" },
  { code: "EHS", nameKo: "안전환경", nameEn: "EHS / Safety" },
];

export const CATEGORIES = [
  { code: "QUALITY", nameKo: "품질", nameEn: "Quality", defaultDepartment: "QUALITY", sortOrder: 1 },
  { code: "MAINTENANCE", nameKo: "설비", nameEn: "Maintenance", defaultDepartment: "MAINTENANCE", sortOrder: 2 },
  { code: "PRODUCTION", nameKo: "생산", nameEn: "Production", defaultDepartment: "PRODUCTION", sortOrder: 3 },
  { code: "MATERIAL", nameKo: "자재/물류", nameEn: "Material / Logistics", defaultDepartment: "LOGISTICS", sortOrder: 4 },
  { code: "SAFETY", nameKo: "안전", nameEn: "Safety", defaultDepartment: "EHS", sortOrder: 5 },
  { code: "OTHER", nameKo: "기타", nameEn: "Other", defaultDepartment: "PRODUCTION", sortOrder: 6 },
];

export const LINES = [
  { code: "TGDI1", name: "T-GDI 1", sortOrder: 1 },
  { code: "TGDI2", name: "T-GDI 2", sortOrder: 2 },
  { code: "MUF1", name: "Muffler 1", sortOrder: 3 },
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

// Demo users (fictional). Phase 1 has no login; the responder picks a name.
export const USERS = [
  { name: "품질 담당 A", departmentCode: "QUALITY", role: "RESPONDER" },
  { name: "품질 담당 B", departmentCode: "QUALITY", role: "RESPONDER" },
  { name: "생산 반장", departmentCode: "PRODUCTION", role: "RESPONDER" },
  { name: "보전 담당", departmentCode: "MAINTENANCE", role: "RESPONDER" },
  { name: "물류 담당", departmentCode: "LOGISTICS", role: "RESPONDER" },
  { name: "안전 담당", departmentCode: "EHS", role: "RESPONDER" },
  { name: "생산 팀장", departmentCode: "PRODUCTION", role: "MANAGER" },
];
