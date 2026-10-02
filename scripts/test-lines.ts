// Line master + UAP line ownership tests (npm run test:lines).
//
// A) In-process, isolated database under work/lines-test/ (never the live DB, never Turso), with a
//    SYNTHETIC workbook built here (fake names; same layout as the plant workbook): line master,
//    workbook parsing + cross-check, import, Supervisor / GAP leader A / B per line, no duplicate
//    employees, repeated import, change of a person, inactive / ended / future assignments ignored,
//    constraints, contact columns never read, public master data without people, history unchanged.
// B) Turso-compatible migration: the remote (libSQL) driver path on a local libSQL file that rejects
//    `PRAGMA user_version = …` like Turso does: v5 with data → v6, data unchanged.
// C) Optional HTTP checks against a running server (BASE_URL=… npm run test:lines -- --http):
//    /api/meta has no people / contact fields; /api/admin/lines needs login + an ownership role.
// D) Optional real workbook (npm run test:lines -- --workbook <file.xlsx>): imported into a fresh
//    isolated DB, every line must resolve to the workbook's Supervisor and A / B GAP leaders. Prints
//    counts only — no names or contact data.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

const args = process.argv.slice(2);
const workbookArg = args.includes("--workbook") ? args[args.indexOf("--workbook") + 1] : null;
const RUN = `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
const DIR = path.resolve("work/lines-test", RUN);
fs.mkdirSync(DIR, { recursive: true });

// The server under test (part C) keeps its own DATABASE_PATH; the in-process parts use a fresh one.
const SERVER_DB = process.env.DATABASE_PATH ?? null;
// Isolated database — must be set before db.ts is imported. Never Turso.
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.BLOB_READ_WRITE_TOKEN;
process.env.DATABASE_PATH = path.join(DIR, "lines.db");
process.env.UPLOAD_DIR = path.join(DIR, "uploads");

let failures = 0;
function check(cond: unknown, label: string) {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.log(`  ✖ ${label}`);
  }
}

const { db, nowIso, migrate, seedMasterData, schemaVersion, SCHEMA_VERSION } = await import("../src/lib/server/db.ts");
const { LINES, UAP_AREAS } = await import("../src/lib/server/masterData.ts");
const { applyOrgImport, resolveLineOwnership, listLineOwnership, importKey } = await import("../src/lib/server/lineAssignments.ts");
const { readOrgWorkbook } = await import("./lib/uap-workbook.ts");
const { getMasterData, createEvent } = await import("../src/lib/server/andonService.ts");

const REAL_LINES = LINES.filter((l) => l.uapAreaCode);
const SENTINEL = "CONTACT-SENTINEL";

// ---------------------------------------------------------------- synthetic organization

interface Group {
  lines: string[];
  A: string;
  B: string;
}
interface Block {
  area: string;
  sv: string;
  groups: Group[];
}
/** Fake organization over the REAL line names: groups of ≤ 3 lines; BENDING mimics the plant case
 *  (one A leader for two sub-groups with different B leaders). */
function fixtureOrg(): Block[] {
  return UAP_AREAS.map((a) => {
    const names = REAL_LINES.filter((l) => l.uapAreaCode === a.code).map((l) => l.name);
    const sizes = a.code === "BENDING" ? [2, 1] : names.length > 3 ? [3, names.length - 3] : [names.length];
    let i = 0;
    const groups = sizes.map((n, gi) => {
      const lines = names.slice(i, (i += n));
      return { lines, A: a.code === "BENDING" ? `리더-${a.code}-A` : `리더-${a.code}-${gi + 1}A`, B: `리더-${a.code}-${gi + 1}B` };
    });
    return { area: a.code, sv: `감독자-${a.code}`, groups };
  });
}

/** Builds a workbook with the plant layout. Contact columns are filled with sentinels. */
async function writeWorkbook(file: string, org: Block[], opts: { breakSupervisorLines?: boolean } = {}) {
  const wb = new ExcelJS.Workbook();
  const people = wb.addWorksheet("개인정보");
  const orgWs = wb.addWorksheet("UAP(Line 구분)");
  people.getCell("B2").value = "-. Information";
  ["생산라인 (호출기준)", "부서", "부서-1", "이름", "직급", "사번", "Google ID", "Kakap Talk ID", "연락처", "FORVIA E-mail", "Remarks"].forEach(
    (h, i) => (people.getCell(3, 2 + i).value = h),
  );
  let r = 4;
  const contact = (row: number) => [7, 8, 9, 10, 11].forEach((c) => (people.getCell(row, c).value = `${SENTINEL}-${row}-${c}`));
  people.getCell(r, 5).value = "팀장-비대상";
  people.getCell(r, 6).value = "팀장";
  contact(r++);
  for (const b of org) {
    const all = b.groups.flatMap((g) => g.lines);
    const top = r;
    const svLines = opts.breakSupervisorLines && b.area === "AP-1" ? all.slice(1) : all;
    people.getCell(r, 2).value = svLines.slice(0, 2).join(", ") + (svLines.length > 2 ? ",\n" + svLines.slice(2).join(", ") : "");
    people.getCell(r, 4).value = b.area;
    people.getCell(r, 5).value = b.sv;
    people.getCell(r, 6).value = "SV";
    contact(r++);
    const gls = new Map<string, { shift: string; lines: string[] }>();
    for (const g of b.groups) {
      for (const [shift, name] of [["A", g.A], ["B", g.B]] as const) {
        const e = gls.get(name) ?? { shift, lines: [] };
        e.lines.push(...g.lines);
        gls.set(name, e);
      }
    }
    // BENDING: like the plant workbook, the B leaders are listed for ALL lines of the area here.
    if (b.area === "BENDING") for (const [, e] of gls) if (e.shift === "B") e.lines = [...all];
    for (const [name, e] of gls) {
      people.getCell(r, 2).value = e.lines.join(", ");
      people.getCell(r, 5).value = `${name}(${e.shift})`;
      people.getCell(r, 6).value = "GL";
      contact(r++);
    }
    people.mergeCells(top, 4, r - 1, 4); // 부서-1 merged over the area's rows, as in the plant file
  }
  // UAP(Line 구분): blocks of "<SV> SV | A | B", two block columns side by side.
  orgWs.getCell("B2").value = "-. UAP Organization";
  const tops = [3, 3];
  org.forEach((b, i) => {
    const side = i % 2;
    const col = side === 0 ? 2 : 6;
    let row = tops[side];
    orgWs.getCell(row, col).value = b.area === "RESO" ? `${b.sv}S/V` : `${b.sv} SV`;
    orgWs.getCell(row, col + 1).value = "A";
    orgWs.getCell(row, col + 2).value = "B";
    row++;
    for (const g of b.groups) {
      g.lines.forEach((l, li) => {
        orgWs.getCell(row, col).value = l;
        if (li === 0) {
          orgWs.getCell(row, col + 1).value = g.A;
          orgWs.getCell(row, col + 2).value = g.B;
        }
        row++;
      });
    }
    tops[side] = row + 1; // blank separator row
  });
  await wb.xlsx.writeFile(file);
}

function expected(org: Block[]) {
  const m = new Map<string, { area: string; sv: string; A: string; B: string }>();
  for (const b of org) for (const g of b.groups) for (const l of g.lines) m.set(l, { area: b.area, sv: b.sv, A: g.A, B: g.B });
  return m;
}
const lineCodeOf = (name: string) => REAL_LINES.find((l) => l.name === name)!.code;

async function checksum(sql: string) {
  return crypto.createHash("sha256").update(JSON.stringify(await db.all(sql))).digest("hex");
}

// ---------------------------------------------------------------- A) in-process

async function partA() {
  console.log(`A) Line master + ownership (isolated DB ${path.relative(process.cwd(), process.env.DATABASE_PATH!)})`);
  check(Number((await db.get("PRAGMA user_version"))?.user_version) === SCHEMA_VERSION && SCHEMA_VERSION >= 6, `schema v${SCHEMA_VERSION} (line master since v6)`);

  // line master
  check(REAL_LINES.length === 36, "36 real UAP lines in the line master definition");
  const lineRows = await db.all("SELECT code, name, uap_area_code FROM line");
  let once = true;
  for (const l of REAL_LINES) {
    const rows = lineRows.filter((r) => r.code === l.code);
    const byName = lineRows.filter((r) => r.name === l.name && r.uap_area_code === l.uapAreaCode);
    if (rows.length !== 1 || byName.length !== 1) once = false;
  }
  check(once, "every imported line exists exactly once (by code and by name within its area)");
  check(new Set(REAL_LINES.map((l) => l.code)).size === 36 && new Set(REAL_LINES.map((l) => `${l.uapAreaCode}|${l.name}`)).size === 36, "line codes and area+name are unique");
  check((await db.all("SELECT 1 FROM uap_area")).length === 7, "7 UAP areas");
  const procs = await db.all("SELECT line_code, placeholder FROM process");
  check(REAL_LINES.every((l) => { const p = procs.filter((x) => x.line_code === l.code); return p.length === 1 && p[0].placeholder === 1; }), "each real line has exactly one placeholder process (real process master pending)");
  check(procs.filter((x) => x.line_code === "TGDI1").every((x) => x.placeholder === 0), "prototype line processes unchanged (not placeholders)");
  const shifts = await db.all("SELECT code, start_time, end_time FROM shift ORDER BY sort_order");
  check(shifts.map((s) => s.code).join() === "A,B" && shifts.every((s) => s.start_time === null && s.end_time === null), "shifts A / B exist without clock times (not confirmed)");

  // history before the import (prototype line + a real line with the placeholder process)
  const realPlaceholder = (await db.get("SELECT id FROM process WHERE line_code = 'AP1-MAIN1'"))!.id as number;
  const tgdiProc = (await db.get("SELECT id FROM process WHERE line_code = 'TGDI1' ORDER BY sort_order LIMIT 1"))!.id as number;
  await createEvent({ lineCode: "TGDI1", processId: tgdiProc, categoryCode: "QUALITY", description: "[TEST] lines history 1", createdBy: "test" });
  const onReal = await createEvent({ lineCode: "AP1-MAIN1", processId: realPlaceholder, categoryCode: "MAINTENANCE", description: "[TEST] lines real line", createdBy: "test" });
  check(onReal.event.departmentCode === "MT", "ANDON on a real line with the placeholder process is created; department still from routing (MAINTENANCE → MT)");
  const sums = {
    event: await checksum("SELECT * FROM andon_event ORDER BY id"),
    transition: await checksum("SELECT * FROM andon_transition ORDER BY id"),
    notification: await checksum("SELECT * FROM notification_log ORDER BY id"),
    routing: await checksum("SELECT * FROM routing_rule ORDER BY id"),
  };
  const maxUser = Number((await db.get("SELECT MAX(id) AS m FROM app_user"))!.m);
  const usersBefore = await checksum(`SELECT * FROM app_user WHERE id <= ${maxUser} ORDER BY id`);

  // workbook parsing
  const org = fixtureOrg();
  const file = path.join(DIR, "fixture.xlsx");
  await writeWorkbook(file, org);
  const parsed = await readOrgWorkbook(file);
  const exp = expected(org);
  check(parsed.lines.length === 36, "parser: 36 lines");
  check(parsed.lines.every((l) => { const e = exp.get(l.lineName); return e && e.area === l.uapAreaCode && e.sv === l.supervisor && e.A === l.gapLeaders.A && e.B === l.gapLeaders.B; }), "parser: area, supervisor and A / B leader per line (sub-groups inherit the leader)");
  check(parsed.warnings.length === 3 && parsed.warnings.every((w) => w.includes("BENDING") || w.includes("CUTTING")), "cross-check: coarser 개인정보 GL line lists are warnings (3, BENDING case)");
  check(!JSON.stringify(parsed).includes(SENTINEL), "parser never returns contact columns");
  const broken = path.join(DIR, "broken.xlsx");
  await writeWorkbook(broken, org, { breakSupervisorLines: true });
  await readOrgWorkbook(broken).then(
    () => check(false, "contradicting sheets are rejected"),
    (e: Error) => check(/lines differ between sheets/.test(e.message), "contradicting sheets are rejected (supervisor line lists differ)"),
  );

  // import
  const r1 = await applyOrgImport(parsed.lines, "fixture.xlsx");
  const persons = new Set(org.flatMap((b) => [b.sv, ...b.groups.flatMap((g) => [g.A, g.B])]));
  check(r1.employeesCreated === persons.size && r1.assignmentsCreated === 36 * 3 && r1.assignmentsEnded === 0, `import: ${r1.employeesCreated} employees, ${r1.assignmentsCreated} assignments`);
  let all = true;
  for (const l of REAL_LINES) {
    const o = await resolveLineOwnership(l.code);
    const e = exp.get(l.name)!;
    if (!o || o.supervisor?.name !== e.sv || o.gapLeaders.A?.name !== e.A || o.gapLeaders.B?.name !== e.B || o.currentGapLeader !== null) all = false;
  }
  check(all, "every line resolves to its expected Supervisor and A / B GAP leader; current leader unknown without a shift");
  const withShift = await resolveLineOwnership("BND-CE-BENDING", { shift: "B" });
  check(withShift?.currentGapLeader?.name === "리더-BENDING-2B", "explicit shift B → that shift's leader (line-specific: CE BENDING ≠ HE BENDING)");
  check((await resolveLineOwnership("BND-HE-BENDING", { shift: "B" }))?.currentGapLeader?.name === "리더-BENDING-1B", "HE BENDING shift B → its own leader");
  await resolveLineOwnership("AP1-MAIN1", { shift: "C" }).then(() => check(false, "unknown shift rejected"), () => check(true, "unknown shift rejected"));
  check((await resolveLineOwnership("NO-SUCH-LINE")) === null, "unknown line → null");

  // one employee per person
  const dupes = await db.all("SELECT name, COUNT(*) AS n FROM app_user WHERE import_key IS NOT NULL GROUP BY name HAVING n > 1");
  check(dupes.length === 0 && Number((await db.get("SELECT COUNT(*) AS n FROM app_user WHERE import_key IS NOT NULL"))!.n) === persons.size, "no duplicate employees (one record per person)");
  const svId = (await resolveLineOwnership("AP1-MAIN1"))!.supervisor!.userId;
  check(REAL_LINES.filter((l) => l.uapAreaCode === "AP-1").length === 6 && (await db.all("SELECT DISTINCT user_id FROM line_assignment WHERE assignment_role = 'SUPERVISOR' AND line_code LIKE 'AP1-%'")).length === 1, "one supervisor record covers all 6 AP-1 lines");
  const benA = await db.all("SELECT DISTINCT user_id FROM line_assignment WHERE assignment_role = 'GAP_LEADER' AND shift_code = 'A' AND line_code LIKE 'BND-%'");
  check(benA.length === 1, "one A-shift leader record covers both BENDING sub-groups");
  const svRow = await db.get("SELECT department_code, role, email, employee_id, phone, kakao_id, company_email, source FROM app_user WHERE id = ?", svId);
  check(svRow?.department_code === "UAP" && svRow.role === "SUPERVISOR" && svRow.email === null && svRow.employee_id === null && svRow.phone === null && svRow.kakao_id === null && svRow.company_email === null, "imported employee: UAP / SUPERVISOR, no login, no contact fields");
  const dbText = JSON.stringify(await db.all("SELECT * FROM app_user")) + JSON.stringify(await db.all("SELECT * FROM line_assignment"));
  check(!dbText.includes(SENTINEL), "no contact data stored by the import");

  // repeat import = no change
  const r2 = await applyOrgImport(parsed.lines, "fixture.xlsx");
  check(r2.employeesCreated === 0 && r2.assignmentsCreated === 0 && r2.assignmentsEnded === 0 && r2.assignmentsUnchanged === 108, "repeated import changes nothing");

  // a changed person: old assignment ended (history), new one in force
  const changed = fixtureOrg();
  changed[0].groups[0].B = "리더-AP-1-새B";
  const f2 = path.join(DIR, "changed.xlsx");
  await writeWorkbook(f2, changed);
  const r3 = await applyOrgImport((await readOrgWorkbook(f2)).lines, "changed.xlsx");
  check(r3.employeesCreated === 1 && r3.assignmentsEnded === 3 && r3.assignmentsCreated === 3, "changed B leader of a 3-line sub-group: 3 ended, 3 created, 1 new employee");
  check((await resolveLineOwnership("AP1-MAIN2"))?.gapLeaders.B?.name === "리더-AP-1-새B", "new leader in force");
  const ended = await db.all("SELECT active, effective_to FROM line_assignment WHERE line_code = 'AP1-MAIN2' AND assignment_role = 'GAP_LEADER' AND shift_code = 'B' ORDER BY id");
  check(ended.length === 2 && ended[0].active === 0 && ended[0].effective_to !== null && ended[1].active === 1, "old assignment kept as ended history");

  // inactive / ended / future / inactive employee are ignored
  await db.run("UPDATE line_assignment SET active = 0, effective_to = ? WHERE line_code = 'AQ1-GPF' AND assignment_role = 'SUPERVISOR' AND active = 1", nowIso());
  check((await resolveLineOwnership("AQ1-GPF"))?.supervisor === null, "inactive (ended) assignment is ignored");
  const future = new Date(Date.now() + 86_400_000).toISOString();
  await db.run(
    "INSERT INTO line_assignment (line_code, user_id, assignment_role, shift_code, effective_from, active, source, created_at) VALUES ('AQ1-GPF', ?, 'SUPERVISOR', NULL, ?, 1, 'ADMIN', ?)",
    svId, future, nowIso(),
  );
  check((await resolveLineOwnership("AQ1-GPF"))?.supervisor === null, "assignment starting in the future is not yet in force");
  check((await resolveLineOwnership("AQ1-GPF", { at: future }))?.supervisor?.userId === svId, "…and is in force from its start");
  const glA = (await resolveLineOwnership("RESO-LOCKSEAM"))!.gapLeaders.A!.userId;
  await db.run("UPDATE app_user SET active = 0 WHERE id = ?", glA);
  check((await resolveLineOwnership("RESO-LOCKSEAM"))?.gapLeaders.A === null, "assignment of a deactivated employee is ignored");
  await db.run("UPDATE app_user SET active = 1 WHERE id = ?", glA);

  // constraints
  const reject = async (sql: string, label: string, ...p: (string | number | null)[]) =>
    check(await db.run(sql, ...p).then(() => false, () => true), label);
  const ins = "INSERT INTO line_assignment (line_code, user_id, assignment_role, shift_code, effective_from, active, source, created_at) VALUES (?, ?, ?, ?, ?, 1, 'ADMIN', ?)";
  await reject(ins, "second active supervisor for a line is rejected (unique)", "AP1-FRT", svId, "SUPERVISOR", null, nowIso(), nowIso());
  await reject(ins, "GAP leader without shift is rejected", "AP1-FRT", svId, "GAP_LEADER", null, nowIso(), nowIso());
  await reject(ins, "supervisor with a shift is rejected", "AP2-CTR1", svId, "SUPERVISOR", "A", nowIso(), nowIso());
  await reject(ins, "unknown shift is rejected (FK)", "AP2-CTR1", svId, "GAP_LEADER", "Z", nowIso(), nowIso());
  await reject(ins, "unknown line is rejected (FK)", "NO-LINE", svId, "SUPERVISOR", null, nowIso(), nowIso());
  await reject(ins, "unknown employee is rejected (FK)", "AP2-CTR1", 999999, "GAP_LEADER", "A", nowIso(), nowIso());
  await reject("UPDATE andon_transition SET comment = 'x'", "history still append-only");

  // public master data: no people, no contact fields
  const meta = await getMasterData();
  const metaText = JSON.stringify(meta);
  const names = [...persons, "리더-AP-1-새B"];
  check(names.every((n) => !metaText.includes(n)), "public master data (/api/meta) contains no supervisor / GAP leader names");
  check(!/phone|kakao|email|employee|google|userId/i.test(metaText), "public master data has no contact / identity fields");
  check(meta.lines.filter((l) => l.uapAreaCode).length === 36 && meta.uapAreas.length === 7, "public master data: 36 real lines with their area, 7 areas");
  check(meta.processes.filter((p) => p.placeholder).length === 36, "public master data marks the 36 placeholder processes");
  const admin = await listLineOwnership();
  check(!/phone|kakao|email|employee_?id|google/i.test(JSON.stringify(admin)), "admin ownership list: names only, no contact fields");

  // history unchanged
  check(
    (await checksum("SELECT * FROM andon_event ORDER BY id")) === sums.event &&
      (await checksum("SELECT * FROM andon_transition ORDER BY id")) === sums.transition &&
      (await checksum("SELECT * FROM notification_log ORDER BY id")) === sums.notification &&
      (await checksum("SELECT * FROM routing_rule ORDER BY id")) === sums.routing,
    "ANDON events, history, notification log and routing unchanged by the imports",
  );
  check((await checksum(`SELECT * FROM app_user WHERE id <= ${maxUser} ORDER BY id`)) === usersBefore, "existing users unchanged");
  check((await db.all("PRAGMA foreign_key_check")).length === 0, "foreign keys OK");
}

// ---------------------------------------------------------------- B) Turso-compatible migration

async function partB() {
  console.log("B) Turso-compatible migration (remote driver path on local libSQL, user_version writes rejected like Turso)");
  const { createClient } = await import("@libsql/client");
  const { RemoteDriver } = await import("../src/lib/server/sql.ts");
  const client = createClient({ url: "file:" + path.join(DIR, "turso-like.db").replaceAll("\\", "/") });
  // Turso rejects writes to PRAGMA user_version; emulate that so the remote code path is really tested.
  const guard = <T extends (...a: never[]) => unknown>(fn: T): T =>
    ((...a: never[]) => {
      const sql = JSON.stringify(a[0]);
      if (/PRAGMA\s+user_version\s*=/i.test(sql)) return Promise.reject(new Error("SQL_PARSE_ERROR: SQL not allowed statement: PRAGMA user_version"));
      return fn(...a);
    }) as T;
  const rawTx = client.transaction.bind(client);
  client.execute = guard(client.execute.bind(client));
  client.executeMultiple = guard(client.executeMultiple.bind(client));
  client.transaction = (async (mode?: "write" | "read" | "deferred") => {
    const tx = await rawTx(mode);
    tx.execute = guard(tx.execute.bind(tx));
    tx.executeMultiple = guard(tx.executeMultiple.bind(tx));
    return tx;
  }) as typeof client.transaction;
  await client.execute("PRAGMA foreign_keys = ON");
  const d = new RemoteDriver(client as never, "turso-like");
  await migrate(d, undefined, 5);
  check((await schemaVersion(d)) === 5, "remote-path database at v5 (version kept in schema_meta)");
  // data in the v5 database
  const now = nowIso();
  await d.exec(`
    INSERT OR IGNORE INTO plant (code, name, name_ko) VALUES ('YC', 'Yeongcheon', '영천');
    INSERT OR IGNORE INTO department (code, name_ko, name_en) VALUES ('QC', '품질', 'Quality');
    INSERT OR IGNORE INTO role (code, name_ko, name_en, can_respond) VALUES ('RESPONDER', '담당자', 'Responder', 1);
    INSERT OR IGNORE INTO category (code, name_ko, name_en, default_department) VALUES ('QUALITY', '품질', 'Quality', 'QC');
    INSERT OR IGNORE INTO line (code, name, plant_code) VALUES ('TGDI1', 'T-GDI 1', 'YC');
    INSERT INTO process (line_code, name) VALUES ('TGDI1', 'zz test process');
    INSERT INTO app_user (name, email, department_code, role, active, source, created_at) VALUES ('[TEST] remote', 'r@andon.test', 'QC', 'RESPONDER', 1, 'REGISTRATION', '${now}');
    INSERT INTO andon_event (id, plant, line_code, process_id, category_code, department_code, description, status, created_by, created_at, updated_at)
      VALUES ('AND-TEST-0001', 'Yeongcheon', 'TGDI1', (SELECT MAX(id) FROM process), 'QUALITY', 'QC', '[TEST] remote', 'OPEN', 'test', '${now}', '${now}');
    INSERT INTO andon_transition (event_id, action, from_status, to_status, user_name, created_at) VALUES ('AND-TEST-0001', 'CREATE', NULL, 'OPEN', 'test', '${now}');
    INSERT INTO notification_log (event_id, provider, recipient, status, message, created_at) VALUES ('AND-TEST-0001', 'mock', 'x', 'SENT', 'm', '${now}');
  `);
  const tables = ["andon_event", "andon_transition", "notification_log", "app_user", "routing_rule", "line", "process", "user_identity", "user_session"];
  // rows that exist before the migration (seeding afterwards may ADD rows, e.g. the 36 new lines)
  const maxRowid: Record<string, number> = {};
  for (const t of tables) maxRowid[t] = Number((await d.get(`SELECT IFNULL(MAX(rowid), 0) AS m FROM "${t}"`))!.m);
  // columns as they exist BEFORE the migration (later migrations only add columns)
  const oldCols: Record<string, string[]> = {};
  for (const t of tables) oldCols[t] = (await d.all(`PRAGMA table_info("${t}")`)).map((c) => `"${c.name as string}"`);
  const snap = async () => {
    const out: Record<string, string> = {};
    for (const t of tables) {
      const cols = oldCols[t];
      out[t] = crypto.createHash("sha256").update(JSON.stringify(await d.all(`SELECT ${cols.join(",")} FROM "${t}" WHERE rowid <= ${maxRowid[t]} ORDER BY rowid`))).digest("hex");
    }
    return out;
  };
  const before = await snap();
  const counts = Object.values(maxRowid).reduce((x, y) => x + y, 0);
  await d.exec("PRAGMA user_version = 1").then(() => check(false, "emulation rejects user_version writes"), () => check(true, "emulation rejects user_version writes (like Turso)"));
  await migrate(d);
  await d.transaction(() => seedMasterData(d));
  check((await schemaVersion(d)) === SCHEMA_VERSION, `migrated v5 → v${SCHEMA_VERSION} (incl. v6 line master) through the remote driver`);
  check(JSON.stringify(await snap()) === JSON.stringify(before), `all ${counts} existing rows / columns unchanged (events, history, notifications, users, routing, lines, processes)`);
  check((await d.all("PRAGMA foreign_key_check")).length === 0, "foreign keys OK after migration");
  check(Number((await d.get("SELECT COUNT(*) AS n FROM line WHERE uap_area_code IS NOT NULL"))!.n) === 36, "line master seeded (36 real lines)");
  check(await d.run("UPDATE andon_transition SET comment = 'x'").then(() => false, () => true), "history append-only after migration");
  d.close();
}

// ---------------------------------------------------------------- C) HTTP

async function partC() {
  const { BASE, Client, admin, registerAccount } = await import("./lib/testkit.ts");
  console.log(`C) HTTP ${BASE}`);
  // admin() runs the masterdata CLI: it must target the SERVER database, never the in-process test DB.
  if (!SERVER_DB) throw new Error("part C needs DATABASE_PATH = the database of the server under test");
  process.env.DATABASE_PATH = path.resolve(SERVER_DB);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check(path.resolve(health.db) === path.resolve(SERVER_DB), "server under test uses DATABASE_PATH");
  const metaText = await fetch(`${BASE}/api/meta`).then((r) => r.text());
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      keys.add(k);
      walk(x);
    }
  };
  walk(JSON.parse(metaText));
  const forbidden = [...keys].filter((k) => /phone|kakao|email|employee|google|user|supervisor|gapLeader|assign|owner/i.test(k));
  check(forbidden.length === 0, `/api/meta: no people, contact or ownership fields (${keys.size} field names checked)`);
  const anon = await new Client("anon").request("GET", "/api/admin/lines");
  check(anon.status === 401, "/api/admin/lines without login → 401");
  const acc = await registerAccount("UAP", "lines");
  const asResponder = await acc.client.request("GET", "/api/admin/lines");
  check(asResponder.status === 403, "self-registered RESPONDER → 403");
  check(admin("user", "role", String(acc.id), "SUPERVISOR").ok, "admin assigns SUPERVISOR (CLI)");
  const asSv = await acc.client.request("GET", "/api/admin/lines");
  const body = asSv.body as { lines?: { supervisor: unknown; gapLeaders: unknown }[] } | null;
  check(asSv.status === 200 && Array.isArray(body?.lines) && body!.lines.length >= 36, "SUPERVISOR → 200 with the line list");
  check(!/phone|kakao|email|employee_?id|google/i.test(JSON.stringify(asSv.body)), "admin response: no contact fields");
  const people = new Set<string>();
  for (const l of (body?.lines ?? []) as { supervisor: { name: string } | null; gapLeaders: Record<string, { name: string } | null> }[]) {
    if (l.supervisor) people.add(l.supervisor.name);
    for (const g of Object.values(l.gapLeaders)) if (g) people.add(g.name);
  }
  check([...people].every((n) => !metaText.includes(n)), `/api/meta contains none of the ${people.size} assigned people`);
  admin("user", "deactivate-test-accounts");
}

// ---------------------------------------------------------------- D) real workbook

async function partD(file: string) {
  console.log("D) Real workbook → fresh isolated DB (counts only, no personal data printed)");
  const parsed = await readOrgWorkbook(file);
  check(parsed.lines.length === 36, `workbook: ${parsed.lines.length} lines`);
  check(parsed.lines.every((l) => REAL_LINES.some((x) => x.name === l.lineName && x.uapAreaCode === l.uapAreaCode)), "every workbook line is in the line master with the same area");
  check(REAL_LINES.every((x) => parsed.lines.filter((l) => l.lineName === x.name).length === 1), "every line master line appears exactly once in the workbook");
  await db.exec("DELETE FROM line_assignment"); // isolated DB only (work/lines-test)
  const r = await applyOrgImport(parsed.lines, path.basename(file));
  let sv = 0, a = 0, b = 0;
  for (const l of parsed.lines) {
    const o = await resolveLineOwnership(lineCodeOf(l.lineName));
    if (o?.supervisor?.name === l.supervisor) sv++;
    if (l.gapLeaders.A && o?.gapLeaders.A?.name === l.gapLeaders.A) a++;
    if (l.gapLeaders.B && o?.gapLeaders.B?.name === l.gapLeaders.B) b++;
  }
  const withA = parsed.lines.filter((l) => l.gapLeaders.A).length;
  const withB = parsed.lines.filter((l) => l.gapLeaders.B).length;
  check(sv === 36, `every line resolves to the workbook's Supervisor (${sv}/36)`);
  check(a === withA, `A-shift GAP leader as in the workbook (${a}/${withA})`);
  check(b === withB, `B-shift GAP leader as in the workbook (${b}/${withB})`);
  const people = new Set(parsed.lines.flatMap((l) => [l.supervisor, l.gapLeaders.A, l.gapLeaders.B].filter(Boolean) as string[]));
  check(Number((await db.get("SELECT COUNT(*) AS n FROM app_user WHERE import_key IN (" + [...people].map(() => "?").join(",") + ")", ...[...people].map(importKey)))!.n) === people.size, `one employee record per person (${people.size}) — import created ${r.employeesCreated}, reused ${r.employeesReused}`);
  console.log(`  (workbook warnings: ${parsed.warnings.length})`);
}

try {
  await partA();
  await partB();
  if (args.includes("--http")) await partC();
  if (workbookArg) await partD(workbookArg);
} catch (err) {
  failures++;
  console.log(`  ✖ unexpected error: ${(err as Error).stack}`);
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
