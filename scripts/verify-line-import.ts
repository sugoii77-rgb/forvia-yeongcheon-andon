// npm run verify:lines -- <workbook.xlsx>
// Read-only check of the configured database (SQLite file or Turso via `vercel env run`) against the
// plant workbook: line master, areas, Supervisor / GAP leader A / B of every line, one employee per
// person — and PRIVACY: no workbook contact value (employee number, Google ID, KakaoTalk ID, phone,
// FORVIA e-mail) is stored anywhere in the database. Contact values are read only to compare them in
// memory; they are never printed or written. Output: counts only.
import fs from "node:fs";
import ExcelJS from "exceljs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("usage: npm run verify:lines -- <workbook.xlsx>");
  process.exit(2);
}
const { db, SCHEMA_VERSION } = await import("../src/lib/server/db.ts");
const { LINES, UAP_AREAS } = await import("../src/lib/server/masterData.ts");
const { resolveLineOwnership, importKey } = await import("../src/lib/server/lineAssignments.ts");
const { readOrgWorkbook, PEOPLE_SHEET } = await import("./lib/uap-workbook.ts");

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`  ${cond ? "✔" : "✖"} ${label}`);
  if (!cond) failures++;
};

/** Contact cells of the personnel sheet (header-based columns). In memory only. */
async function contactValues(): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(PEOPLE_SHEET)!;
  const wanted = /^(사번|google id|kak[ao]+p? ?talk id|kakao ?talk id|연락처|forvia e-?mail)$/i;
  let header = 0;
  const cols: number[] = [];
  for (let r = 1; r <= Math.min(ws.rowCount, 20) && !header; r++) {
    for (let c = 1; c <= ws.columnCount; c++) if (wanted.test(String(ws.getCell(r, c).value ?? "").trim())) cols.push(c);
    if (cols.length) header = r;
  }
  if (cols.length < 5) throw new Error(`expected 5 contact columns in ${PEOPLE_SHEET}, found ${cols.length}`);
  const out = new Set<string>();
  for (let r = header + 1; r <= ws.rowCount; r++) {
    for (const c of cols) {
      const v = ws.getCell(r, c).value as unknown;
      const t = (typeof v === "object" && v && "text" in v ? String((v as { text: unknown }).text) : String(v ?? "")).trim();
      if (t.length >= 4 && t !== "-") {
        out.add(t.toLowerCase());
        const digits = t.replace(/\D/g, "");
        if (digits.length >= 7) out.add(digits); // phone written with / without separators
      }
    }
  }
  return [...out];
}

try {
  const info = await db.info();
  console.log(`database : ${info.label} (${info.kind}) — read only`);
  const version = info.kind === "remote"
    ? Number((await db.get("SELECT version FROM schema_meta WHERE id = 1"))?.version)
    : Number((await db.get("PRAGMA user_version"))?.user_version);
  check(version === SCHEMA_VERSION, `schema v${version}`);

  // line master
  const real = LINES.filter((l) => l.uapAreaCode);
  const rows = await db.all("SELECT code, name, uap_area_code, active FROM line");
  check(real.every((l) => rows.filter((r) => r.code === l.code && r.name === l.name && r.uap_area_code === l.uapAreaCode && r.active === 1).length === 1), `all ${real.length} real lines present once, active, correct area`);
  const areas = await db.all("SELECT code FROM uap_area WHERE active = 1 ORDER BY sort_order");
  check(areas.map((a) => a.code).join() === UAP_AREAS.map((a) => a.code).join(), `${areas.length} UAP areas (${areas.map((a) => a.code).join(", ")})`);
  const demo = rows.filter((r) => !r.uap_area_code);
  console.log(`    prototype lines: ${demo.length} (${demo.filter((r) => r.active === 1).length} shown to operators)`);

  // ownership = workbook
  const parsed = await readOrgWorkbook(file);
  let sv = 0, a = 0, b = 0;
  for (const l of parsed.lines) {
    const code = real.find((x) => x.name === l.lineName && x.uapAreaCode === l.uapAreaCode)?.code;
    const o = code ? await resolveLineOwnership(code) : null;
    if (o?.supervisor?.name === l.supervisor) sv++;
    if (o?.gapLeaders.A?.name === l.gapLeaders.A) a++;
    if (o?.gapLeaders.B?.name === l.gapLeaders.B) b++;
    if (o?.currentGapLeader) failures++; // never inferred without an explicit shift
  }
  check(sv === 36, `Supervisor as in the workbook: ${sv}/36`);
  check(a === 36, `A-shift GAP leader as in the workbook: ${a}/36`);
  check(b === 36, `B-shift GAP leader as in the workbook: ${b}/36`);
  const people = [...new Set(parsed.lines.flatMap((l) => [l.supervisor, l.gapLeaders.A, l.gapLeaders.B].filter(Boolean) as string[]))];
  const keys = people.map(importKey);
  const ph = keys.map(() => "?").join(",");
  const emp = await db.all(`SELECT id, role, department_code, email, employee_id, phone, kakao_id, company_email, active FROM app_user WHERE import_key IN (${ph})`, ...keys);
  check(emp.length === people.length && new Set(emp.map((e) => e.id)).size === people.length, `one employee record per person (${emp.length}/${people.length})`);
  check(emp.every((e) => e.department_code === "UAP" && (e.role === "SUPERVISOR" || e.role === "GAP_LEADER") && e.active === 1), "imported employees: UAP, SUPERVISOR / GAP_LEADER, active");
  check(Number((await db.get("SELECT COUNT(*) AS n FROM line_assignment WHERE active = 1"))?.n) === 108, "108 active assignments (36 lines × supervisor, A, B)");
  console.log(`    workbook warnings (pending plant confirmation): ${parsed.warnings.length}`);

  // privacy
  check(emp.every((e) => e.email === null && e.employee_id === null && e.phone === null && e.kakao_id === null && e.company_email === null), "imported employees: e-mail, employee number, phone, KakaoTalk ID, company e-mail all empty");
  const ids = emp.map((e) => Number(e.id));
  const idph = ids.map(() => "?").join(",");
  check(Number((await db.get(`SELECT COUNT(*) AS n FROM user_identity WHERE user_id IN (${idph})`, ...ids))?.n) === 0, "imported employees: no login identity (no Google ID)");
  const secrets = await contactValues();
  const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((r) => r.name as string);
  // A person who registered THEMSELVES (/register or Google onboarding) typed their own login e-mail;
  // that is account data, not workbook-derived. It is reported separately and does not fail the check.
  const selfRegistered = new Set(
    (await db.all("SELECT id FROM app_user WHERE source = 'REGISTRATION' AND import_key IS NULL")).map((r) => Number(r.id)),
  );
  const isSelfLogin = (t: string, col: string, row: Record<string, unknown>) =>
    (t === "app_user" && col === "email" && selfRegistered.has(Number(row.id))) ||
    (t === "user_identity" && (col === "subject" || col === "provider_email") && selfRegistered.has(Number(row.user_id)));
  let cells = 0, hits = 0, selfHits = 0;
  const where = new Map<string, number>();
  for (const t of tables) {
    for (const row of await db.all(`SELECT * FROM "${t}"`)) {
      for (const [col, v] of Object.entries(row)) {
        if (typeof v !== "string") continue;
        cells++;
        const low = v.toLowerCase();
        const digits = v.replace(/D/g, "");
        // short numeric values (e.g. employee numbers) only as an exact cell value, to avoid timestamp noise
        const hit = secrets.some((x) => (/^d+$/.test(x) ? (x.length >= 7 ? digits.includes(x) : v.trim() === x) : low.includes(x)));
        if (!hit) continue;
        const self = isSelfLogin(t, col, row);
        if (self) selfHits++;
        else hits++;
        const owner = t === "app_user" ? ` user #${row.id}` : t === "user_identity" ? ` user #${row.user_id}` : "";
        const k = `${t}.${col}${owner}${self ? " — own login e-mail of a self-registered account" : ""}`;
        where.set(k, (where.get(k) ?? 0) + 1);
      }
    }
  }
  for (const [k, n] of where) console.log(`    found in ${k}: ${n} (value not shown)`);
  check(hits === 0, `no workbook-derived contact value in the database (${secrets.length} values × ${cells} text cells in ${tables.length} tables; matches: ${hits})`);
  if (selfHits) console.log(`    note: ${selfHits} value(s) are the person's own login e-mail entered at self-registration (not imported)`);
} catch (err) {
  failures++;
  console.error(`  ✖ ${(err as Error).message}`);
}
console.log(failures === 0 ? "VERIFY PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
