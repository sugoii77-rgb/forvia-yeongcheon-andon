// Reads the plant organization workbook ("모바일 안돈시스템(…).xlsx") and cross-checks its two sheets:
//   UAP(Line 구분)  blocks "<name> SV | A | B": one row per line, A / B = GAP leader of shift A / B.
//                   A blank A/B cell continues the GAP leader of the row above (sub-group of lines).
//   개인정보        one row per person: 생산라인 (호출기준), 부서-1 (UAP area), 이름 ("이름(A)" = shift A),
//                   직급 (SV / GL).
// Only these columns are read. Contact columns (사번, Google ID, Kakao Talk ID, 연락처, E-mail) are never
// read, returned or printed.
//
// Resolution: the UAP sheet is line-specific and therefore decides each line's GAP leader. The 개인정보
// sheet must agree on supervisors and areas (otherwise error); where it lists a GAP leader for MORE
// lines than the UAP sheet gives them, that is reported as a warning.
import ExcelJS from "exceljs";
import type { OrgLine } from "../../src/lib/server/lineAssignments.ts";

export const ORG_SHEET = "UAP(Line 구분)";
export const PEOPLE_SHEET = "개인정보";

export interface ParsedOrg {
  lines: OrgLine[];
  warnings: string[];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Cell text as written (line breaks kept); merged cells read their top-left value. */
function rawText(cell: ExcelJS.Cell): string {
  const v = (cell.isMerged ? cell.master : cell).value as unknown;
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: string };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.result !== undefined) return String(o.result ?? "");
    if (o.text !== undefined) return String(o.text);
  }
  return String(v);
}
const text = (cell: ExcelJS.Cell) => norm(rawText(cell));

const SV_HEADER = /^(.+?)\s*S\s*\/?\s*V$/i;

/** UAP(Line 구분): supervisor blocks → lines with A / B GAP leaders. */
function parseOrgSheet(ws: ExcelJS.Worksheet) {
  const out: { lineName: string; supervisor: string; gapLeaders: { A: string | null; B: string | null } }[] = [];
  const cell = (r: number, c: number) => (r <= ws.rowCount && c <= ws.columnCount ? text(ws.getCell(r, c)) : "");
  const isHeader = (r: number, c: number) => SV_HEADER.test(cell(r, c)) && cell(r, c + 1) === "A" && cell(r, c + 2) === "B";
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= ws.columnCount; c++) {
      if (!isHeader(r, c)) continue;
      const supervisor = norm(SV_HEADER.exec(cell(r, c))![1]);
      let a: string | null = null;
      let b: string | null = null;
      for (let rr = r + 1; rr <= ws.rowCount && cell(rr, c) && !isHeader(rr, c); rr++) {
        if (cell(rr, c + 1)) a = cell(rr, c + 1);
        if (cell(rr, c + 2)) b = cell(rr, c + 2);
        out.push({ lineName: cell(rr, c), supervisor, gapLeaders: { A: a, B: b } });
      }
    }
  }
  return out;
}

/** 개인정보: SV / GL rows (name, shift, area, lines). */
function parsePeopleSheet(ws: ExcelJS.Worksheet) {
  let header = 0;
  const col: Record<string, number> = {};
  for (let r = 1; r <= Math.min(ws.rowCount, 20) && !header; r++) {
    for (let c = 1; c <= ws.columnCount; c++) {
      const t = text(ws.getCell(r, c));
      if (t.startsWith("생산라인")) col.lines = c;
      if (t === "부서-1") col.area = c;
      if (t === "이름") col.name = c;
      if (t === "직급") col.position = c;
    }
    if (col.lines && col.area && col.name && col.position) header = r;
  }
  if (!header) throw new Error(`sheet ${PEOPLE_SHEET}: header row with 생산라인 / 부서-1 / 이름 / 직급 not found`);
  const people: { name: string; shift: string | null; position: "SV" | "GL"; area: string; lines: string[] }[] = [];
  for (let r = header + 1; r <= ws.rowCount; r++) {
    const position = text(ws.getCell(r, col.position)).toUpperCase();
    if (position !== "SV" && position !== "GL") continue;
    const raw = text(ws.getCell(r, col.name));
    const m = /^(.*?)\s*\(\s*([AB])\s*\)\s*$/.exec(raw);
    people.push({
      name: norm(m ? m[1] : raw),
      shift: m ? m[2] : null,
      position,
      area: text(ws.getCell(r, col.area)),
      lines: rawText(ws.getCell(r, col.lines))
        .split(/[,\n]/)
        .map(norm)
        .filter(Boolean),
    });
  }
  return people;
}

/** Parses + cross-checks the workbook. Throws on contradictions; returns warnings for coarser data. */
export async function readOrgWorkbook(file: string): Promise<ParsedOrg> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const orgWs = wb.getWorksheet(ORG_SHEET);
  const peopleWs = wb.getWorksheet(PEOPLE_SHEET);
  if (!orgWs || !peopleWs) throw new Error(`workbook must contain the sheets "${ORG_SHEET}" and "${PEOPLE_SHEET}"`);
  const org = parseOrgSheet(orgWs);
  const people = parsePeopleSheet(peopleWs);
  const errors: string[] = [];
  const warnings: string[] = [];

  const names = org.map((o) => o.lineName);
  for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) errors.push(`line "${n}" appears more than once in ${ORG_SHEET}`);
  for (const o of org) {
    if (!o.gapLeaders.A) warnings.push(`line "${o.lineName}": no shift A GAP leader in ${ORG_SHEET}`);
    if (!o.gapLeaders.B) warnings.push(`line "${o.lineName}": no shift B GAP leader in ${ORG_SHEET}`);
  }

  // Supervisors: same lines and an area in 개인정보.
  const areaOf = new Map<string, string>();
  for (const sv of new Set(org.map((o) => o.supervisor))) {
    const rows = people.filter((p) => p.position === "SV" && p.name === sv);
    if (rows.length !== 1) {
      errors.push(`supervisor "${sv}" found ${rows.length}× as SV in ${PEOPLE_SHEET}`);
      continue;
    }
    const mine = org.filter((o) => o.supervisor === sv).map((o) => o.lineName).sort();
    const listed = [...rows[0].lines].sort();
    if (mine.join("|") !== listed.join("|")) errors.push(`supervisor "${sv}": lines differ between sheets (${mine.join(", ")} vs ${listed.join(", ")})`);
    if (!rows[0].area) errors.push(`supervisor "${sv}": no UAP area (부서-1) in ${PEOPLE_SHEET}`);
    for (const l of mine) areaOf.set(l, rows[0].area);
  }
  for (const p of people.filter((x) => x.position === "SV")) {
    if (!org.some((o) => o.supervisor === p.name)) errors.push(`SV "${p.name}" in ${PEOPLE_SHEET} has no block in ${ORG_SHEET}`);
  }

  // GAP leaders: the UAP sheet's leader must be listed for that line and shift in 개인정보.
  const gls = people.filter((p) => p.position === "GL");
  for (const g of gls) if (!g.shift) errors.push(`GL "${g.name}" in ${PEOPLE_SHEET} has no (A)/(B) shift`);
  for (const o of org) {
    for (const s of ["A", "B"] as const) {
      const leader = o.gapLeaders[s];
      const listed = gls.filter((g) => g.shift === s && g.lines.includes(o.lineName)).map((g) => g.name);
      if (leader && !listed.includes(leader)) errors.push(`line "${o.lineName}" shift ${s}: "${leader}" (${ORG_SHEET}) is not listed for this line in ${PEOPLE_SHEET}`);
      for (const other of listed.filter((n) => n !== leader)) {
        warnings.push(`line "${o.lineName}" shift ${s}: ${PEOPLE_SHEET} also lists "${other}"; ${ORG_SHEET} (line-specific) assigns "${leader ?? "nobody"}" — using ${ORG_SHEET}`);
      }
    }
  }
  for (const g of gls) {
    for (const l of g.lines) if (!names.includes(l)) errors.push(`GL "${g.name}": line "${l}" of ${PEOPLE_SHEET} is not in ${ORG_SHEET}`);
  }

  if (errors.length) throw new Error(`workbook check failed:\n  - ${errors.join("\n  - ")}`);
  return {
    lines: org.map((o) => ({ lineName: o.lineName, uapAreaCode: areaOf.get(o.lineName)!, supervisor: o.supervisor, gapLeaders: o.gapLeaders })),
    warnings,
  };
}
