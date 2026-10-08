// A/B shift schedule tests (npm run test:shifts). Fixed timestamps only — never the real current date.
// The anchor used here (week of Monday 2026-10-05, DAY team A) is a TEST VALUE, not the plant's anchor.
//
// A) pure resolver matrix (Asia/Seoul, boundaries, weekly swap, DST independence, anchor validation)
// B) isolated database under work/shifts-test/: schedule seed, ANDON creation without / with a broken
//    schedule, anchor validation + audit, snapshot of team / GAP leader / supervisor on new events
// C) --http (BASE_URL + DATABASE_PATH of the server): view / change permissions, validation, Origin, audit
// D) Turso-compatible migration v6 → v7 (remote driver on local libSQL that rejects user_version writes)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveShift, YEONGCHEON_SHIFT_RULE as RULE, type ResolvedShift, type ShiftAnchor } from "../src/lib/shiftSchedule.ts";

const DIR = path.resolve("work/shifts-test", `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`);
fs.mkdirSync(DIR, { recursive: true });
// The server under test (part C) keeps its own DATABASE_PATH; parts B / D use a fresh one.
const SERVER_DB = process.env.DATABASE_PATH ?? null;
// Isolated database for parts B / D — set before db.ts is imported. Never Turso.
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.BLOB_READ_WRITE_TOKEN;
process.env.DATABASE_PATH = path.join(DIR, "shifts.db");
process.env.UPLOAD_DIR = path.join(DIR, "uploads");

let failures = 0;
function check(cond: unknown, label: string) {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.log(`  ✖ ${label}`);
  }
}

const ANCHOR: ShiftAnchor = { anchorWeekMonday: "2026-10-05", anchorDayTeam: "A" };
const r = (at: string, anchor: ShiftAnchor = ANCHOR) => resolveShift(at, RULE, anchor) as ResolvedShift;
const is = (x: ResolvedShift, exp: Partial<ResolvedShift>) => Object.entries(exp).every(([k, v]) => (x as unknown as Record<string, unknown>)[k] === v);
const throwsCode = (fn: () => unknown, code: string) => {
  try {
    fn();
    return false;
  } catch (e) {
    return (e as { code?: string }).code === code;
  }
};

function partA() {
  console.log("A) Shift resolver (pure, Asia/Seoul; test anchor = week of Mon 2026-10-05, DAY team A)");
  // 1. Monday 07:59:59 → still the Sunday NIGHT shift of the PREVIOUS week
  check(
    is(r("2026-10-05T07:59:59+09:00"), {
      shiftType: "NIGHT", operationalDate: "2026-10-04", rotationWeekStart: "2026-09-28", rotationWeek: -1, dayTeam: "B", nightTeam: "A", activeTeam: "A",
      shiftStart: "2026-10-04T20:00:00+09:00", shiftEnd: "2026-10-05T08:00:00+09:00", nextChangeAt: "2026-10-05T08:00:00+09:00", nextRotationAt: "2026-10-05T08:00:00+09:00",
    }),
    "1. Mon 07:59:59 → NIGHT of Sunday 10-04, previous rotation week (night team A), swap at Mon 08:00",
  );
  // 2. Monday 08:00:00 → new week, DAY = anchor team
  check(
    is(r("2026-10-05T08:00:00+09:00"), { shiftType: "DAY", operationalDate: "2026-10-05", rotationWeekStart: "2026-10-05", rotationWeek: 0, dayTeam: "A", activeTeam: "A", shiftStart: "2026-10-05T08:00:00+09:00", shiftEnd: "2026-10-05T20:00:00+09:00", nextRotationAt: "2026-10-12T08:00:00+09:00" }),
    "2. Mon 08:00:00 → DAY, new rotation week 0, team A",
  );
  check(is(r("2026-10-05T19:59:59+09:00"), { shiftType: "DAY", activeTeam: "A", nextChangeAt: "2026-10-05T20:00:00+09:00" }), "3. Mon 19:59:59 → still DAY (A), next change 20:00");
  check(is(r("2026-10-05T20:00:00+09:00"), { shiftType: "NIGHT", operationalDate: "2026-10-05", activeTeam: "B", shiftEnd: "2026-10-06T08:00:00+09:00" }), "4. Mon 20:00:00 → NIGHT (B) until Tue 08:00");
  check(is(r("2026-10-06T13:15:00+09:00"), { shiftType: "DAY", operationalDate: "2026-10-06", rotationWeek: 0, activeTeam: "A" }), "5. Tuesday daytime → DAY, team A");
  check(is(r("2026-10-11T13:00:00+09:00"), { shiftType: "DAY", operationalDate: "2026-10-11", rotationWeek: 0, activeTeam: "A" }), "6. Sunday daytime → DAY, same week, team A");
  check(
    is(r("2026-10-11T23:30:00+09:00"), { shiftType: "NIGHT", operationalDate: "2026-10-11", rotationWeek: 0, activeTeam: "B" }) &&
      is(r("2026-10-12T03:00:00+09:00"), { shiftType: "NIGHT", operationalDate: "2026-10-11", rotationWeek: 0, activeTeam: "B" }),
    "7. Sunday night (23:30 and Mon 03:00) → Sunday NIGHT, team B, still week 0",
  );
  check(is(r("2026-10-12T07:59:59+09:00"), { shiftType: "NIGHT", operationalDate: "2026-10-11", rotationWeek: 0, activeTeam: "B", nextRotationAt: "2026-10-12T08:00:00+09:00" }), "8. following Mon 07:59:59 → still week 0 Sunday NIGHT (B)");
  check(is(r("2026-10-12T08:00:00+09:00"), { shiftType: "DAY", operationalDate: "2026-10-12", rotationWeek: 1, dayTeam: "B", nightTeam: "A", activeTeam: "B" }), "9. following Mon 08:00:00 → week 1, A/B swapped: DAY = B");
  check(
    is(r("2026-10-19T08:00:00+09:00"), { rotationWeek: 2, dayTeam: "A", activeTeam: "A" }) &&
      is(r("2026-10-19T20:00:00+09:00"), { rotationWeek: 2, activeTeam: "B" }) &&
      is(r("2026-09-21T10:00:00+09:00"), { rotationWeek: -2, dayTeam: "A" }) &&
      is(r("2027-10-04T10:00:00+09:00"), { rotationWeek: 52, dayTeam: "A" }),
    "10. two weeks later (and two weeks before, 52 weeks later) → original pattern DAY = A",
  );
  // Input in UTC (as on Vercel) gives the same plant-local answer.
  check(is(r("2026-10-04T23:00:00Z"), { shiftType: "DAY", operationalDate: "2026-10-05", rotationWeek: 0, activeTeam: "A" }) && is(r("2026-10-04T22:59:59Z"), { shiftType: "NIGHT", operationalDate: "2026-10-04" }), "UTC input 23:00Z = Mon 08:00 KST → new week (server UTC irrelevant)");

  // 11. DST: Asia/Seoul has none; US / EU transitions and the process time zone change nothing.
  const dstDates = ["2026-11-01T10:00:00+09:00", "2026-10-25T10:00:00+09:00", "2027-03-14T10:00:00+09:00", "2027-03-28T10:00:00+09:00", "2027-03-28T21:00:00+09:00"];
  const twelveHours = dstDates.every((d) => {
    const x = r(d);
    return new Date(x.shiftEnd).getTime() - new Date(x.shiftStart).getTime() === 12 * 3_600_000 && x.shiftStart.endsWith("+09:00") && x.shiftEnd.endsWith("+09:00");
  });
  const matrix = ["2026-10-05T07:59:59+09:00", "2026-10-05T08:00:00+09:00", "2026-10-11T23:30:00+09:00", "2026-10-12T08:00:00+09:00", ...dstDates];
  const baseline = JSON.stringify(matrix.map((d) => r(d)));
  const savedTz = process.env.TZ;
  const sameUnderTz = ["America/New_York", "Europe/Berlin", "UTC", "Pacific/Auckland"].every((tz) => {
    process.env.TZ = tz;
    return JSON.stringify(matrix.map((d) => r(d))) === baseline;
  });
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
  check(twelveHours && sameUnderTz, "11. DST: always 12-hour shifts at +09:00 across US / EU DST dates; same results with process TZ New York / Berlin / UTC / Auckland");

  // 12. / 13. anchor missing / invalid
  const none = resolveShift("2026-10-05T08:00:00+09:00", RULE, { anchorWeekMonday: null, anchorDayTeam: null });
  check(!none.ok && none.code === "SHIFT_SCHEDULE_NOT_ANCHORED", "12. no anchor → SHIFT_SCHEDULE_NOT_ANCHORED (no A/B guess)");
  const bad: [ShiftAnchor, string][] = [
    [{ anchorWeekMonday: "2026-10-06", anchorDayTeam: "A" }, "not a Monday"],
    [{ anchorWeekMonday: "2026-02-30", anchorDayTeam: "A" }, "impossible date"],
    [{ anchorWeekMonday: "2026/10/05", anchorDayTeam: "A" }, "wrong format"],
    [{ anchorWeekMonday: "2026-10-05", anchorDayTeam: "C" as never }, "team C"],
    [{ anchorWeekMonday: "2026-10-05", anchorDayTeam: null }, "team missing"],
    [{ anchorWeekMonday: null, anchorDayTeam: "B" }, "week missing"],
  ];
  check(bad.every(([a]) => throwsCode(() => resolveShift("2026-10-05T08:00:00+09:00", RULE, a), "SHIFT_ANCHOR_INVALID")), `13. invalid anchors rejected (${bad.map(([, l]) => l).join(", ")})`);
  check(
    throwsCode(() => resolveShift("2026-10-05T08:00:00+09:00", { ...RULE, nightStart: "21:00" }, ANCHOR), "SHIFT_RULE_INVALID") &&
      throwsCode(() => resolveShift("2026-10-05T08:00:00+09:00", { ...RULE, timeZone: "Mars/Base" }, ANCHOR), "SHIFT_RULE_INVALID") &&
      throwsCode(() => resolveShift("not a date", RULE, ANCHOR), "SHIFT_TIME_INVALID"),
    "invalid rule (not 12 h, unknown zone) and invalid timestamp rejected",
  );
}

// ---------------------------------------------------------------- B) database (isolated)

const T = (local: string) => new Date(local).toISOString(); // fixed plant-local time → stored UTC ISO

async function partB() {
  const { db, nowIso } = await import("../src/lib/server/db.ts");
  const { createEvent, getEvent, getMasterData } = await import("../src/lib/server/andonService.ts");
  const { applyOrgImport, resolveLineOwnership } = await import("../src/lib/server/lineAssignments.ts");
  const { getShiftConfig, currentShift, setShiftAnchor, listShiftAudit, shiftSnapshotForLine } = await import("../src/lib/server/shiftService.ts");
  console.log(`B) Schedule, anchor audit and ANDON snapshot (isolated DB ${path.relative(process.cwd(), process.env.DATABASE_PATH!)})`);

  const cfg = await getShiftConfig();
  check(
    cfg.rule.timeZone === "Asia/Seoul" && cfg.rule.dayStart === "08:00" && cfg.rule.nightStart === "20:00" && cfg.rule.rotationWeekday === "MONDAY" && cfg.anchor.anchorWeekMonday === null && cfg.anchor.anchorDayTeam === null,
    "schedule seeded with the confirmed rule (Asia/Seoul, 08:00 / 20:00, Monday) and NO anchor",
  );
  const unanchored = await currentShift(T("2026-10-05T10:00:00+09:00"));
  check(!unanchored.ok && unanchored.code === "SHIFT_SCHEDULE_NOT_ANCHORED", "12. server: no anchor → SHIFT_SCHEDULE_NOT_ANCHORED");

  // two lines with fake ownership (test names only)
  await applyOrgImport(
    [
      { lineName: "Main #1", uapAreaCode: "AP-1", supervisor: "감독자-T1", gapLeaders: { A: "리더-T1-A", B: "리더-T1-B" } },
      { lineName: "CE BENDING", uapAreaCode: "BENDING", supervisor: "감독자-T2", gapLeaders: { A: "리더-T2-A", B: "리더-T2-B" } },
    ],
    "test",
  );
  // The fixed test timestamps (week of 2026-10-05) must lie inside the assignments' validity, whatever the
  // real date of the run is: the import starts them "now", so start them before the test week.
  await db.run("UPDATE line_assignment SET effective_from = '2026-01-01T00:00:00.000Z' WHERE source_ref = 'test'");
  const asg = async (line: string, role: string, team: string | null) =>
    Number((await db.get("SELECT id FROM line_assignment WHERE line_code = ? AND assignment_role = ? AND IFNULL(shift_code,'-') = IFNULL(?, '-') AND active = 1", line, role, team))!.id);
  const ids = { sv: await asg("AP1-MAIN1", "SUPERVISOR", null), a: await asg("AP1-MAIN1", "GAP_LEADER", "A"), b: await asg("AP1-MAIN1", "GAP_LEADER", "B") };
  const proc = Number((await db.get("SELECT id FROM process WHERE line_code = 'AP1-MAIN1'"))!.id);
  const create = (at: string, category = "MAINTENANCE") =>
    createEvent({ lineCode: "AP1-MAIN1", processId: proc, categoryCode: category, description: `[TEST] shift ${at}`, createdBy: "test", createdAt: T(at) });
  const row = async (id: string) => (await db.get("SELECT * FROM andon_event WHERE id = ?", id))!;

  // 15. ANDON creation without anchor / with a broken schedule
  const e0 = await create("2026-10-05T10:00:00+09:00");
  const r0 = await row(e0.event.id);
  check(
    e0.event.status === "OPEN" && e0.event.departmentCode === "MT" && r0.shift_status === "UNRESOLVED" && r0.shift_unresolved_reason === "SHIFT_SCHEDULE_NOT_ANCHORED" && r0.shift_team === null && r0.gap_leader_assignment_id === null && Number(r0.supervisor_assignment_id) === ids.sv,
    "15. no anchor: ANDON created (OPEN, routed to MT), shift UNRESOLVED / NOT_ANCHORED, no team guessed, supervisor still recorded",
  );
  await db.run("UPDATE shift_schedule SET night_start = '21:00'");
  const e1 = await create("2026-10-05T11:00:00+09:00", "QUALITY");
  check(e1.event.status === "OPEN" && e1.event.departmentCode === "QC" && (await row(e1.event.id)).shift_unresolved_reason === "SHIFT_RULE_INVALID", "15. broken schedule rule: ANDON still created (routed to QC), stored as UNRESOLVED / SHIFT_RULE_INVALID");
  await db.run("UPDATE shift_schedule SET night_start = '20:00'");
  const saved = await db.get("SELECT * FROM shift_schedule WHERE plant_code = 'YC'");
  await db.run("DELETE FROM shift_schedule WHERE plant_code = 'YC'");
  const e2 = await create("2026-10-05T12:00:00+09:00");
  check(e2.event.status === "OPEN" && (await row(e2.event.id)).shift_unresolved_reason === "SHIFT_SCHEDULE_MISSING", "15. missing schedule row: ANDON still created, UNRESOLVED / SHIFT_SCHEDULE_MISSING");
  await db.run(
    "INSERT INTO shift_schedule (plant_code, time_zone, day_start, night_start, rotation_weekday) VALUES (?, ?, ?, ?, ?)",
    saved!.plant_code as string, saved!.time_zone as string, saved!.day_start as string, saved!.night_start as string, saved!.rotation_weekday as string,
  );

  // 14. anchor changes are validated and audited
  const eventsBefore = JSON.stringify(await db.all("SELECT * FROM andon_event ORDER BY id"));
  const bad = await setShiftAnchor({ anchorWeekMonday: "2026-10-06", anchorDayTeam: "A" }, { userId: null, name: "test admin", source: "CLI" }).then(() => null, (e) => e);
  check(bad?.status === 400 && bad.code === "SHIFT_ANCHOR_INVALID" && (await listShiftAudit()).length === 0 && (await getShiftConfig()).anchor.anchorWeekMonday === null, "13. server: invalid anchor (Tuesday) rejected, nothing written, no audit row");
  const first = await setShiftAnchor({ anchorWeekMonday: "2026-09-28", anchorDayTeam: "B" }, { userId: null, name: "test admin", source: "CLI", clientIp: "127.0.0.1" });
  const second = await setShiftAnchor({ anchorWeekMonday: "2026-10-05", anchorDayTeam: "A" }, { userId: null, name: "test admin 2", source: "WEB" });
  const same = await setShiftAnchor({ anchorWeekMonday: "2026-10-05", anchorDayTeam: "A" }, { userId: null, name: "test admin 3", source: "WEB" });
  const audit = await listShiftAudit();
  check(
    first.changed && second.changed && !same.changed && audit.length === 2 &&
      audit[1].old.anchorWeekMonday === null && audit[1].new.anchorWeekMonday === "2026-09-28" && audit[1].new.anchorDayTeam === "B" && audit[1].changedBy === "test admin" && audit[1].source === "CLI" &&
      audit[0].old.anchorWeekMonday === "2026-09-28" && audit[0].old.anchorDayTeam === "B" && audit[0].new.anchorWeekMonday === "2026-10-05" && audit[0].new.anchorDayTeam === "A" && audit[0].changedBy === "test admin 2" && !!audit[0].changedAt,
    "14. anchor changes audited: who, when, source, old → new (unchanged value → no audit row)",
  );
  check(await db.run("UPDATE shift_schedule_audit SET changed_by = 'x'").then(() => false, () => true), "14. audit log is append-only (UPDATE rejected)");
  check(await db.run("DELETE FROM shift_schedule_audit").then(() => false, () => true), "14. audit log is append-only (DELETE rejected)");
  check(JSON.stringify(await db.all("SELECT * FROM andon_event ORDER BY id")) === eventsBefore, "anchor changes never rewrite existing ANDON events (unresolved snapshots stay as they were)");
  const config = await getShiftConfig();
  check(config.updatedBy === "test admin 2" && !!config.updatedAt, "schedule shows who changed the anchor last");

  // 16. / 17. / 18. snapshot with anchor (week of 2026-10-05: DAY = A)
  const day = await create("2026-10-05T10:00:00+09:00");
  const night = await create("2026-10-05T21:00:00+09:00");
  const early = await create("2026-10-05T07:59:59+09:00");
  const nextWeek = await create("2026-10-12T10:00:00+09:00");
  const [d, n, e, w] = [await row(day.event.id), await row(night.event.id), await row(early.event.id), await row(nextWeek.event.id)];
  check(d.shift_status === "RESOLVED" && d.shift_team === "A" && d.shift_type === "DAY" && d.shift_operational_date === "2026-10-05" && d.shift_start_at === "2026-10-05T08:00:00+09:00" && Number(d.gap_leader_assignment_id) === ids.a, "16. Mon 10:00 → team A DAY, snapshot = the line's A-shift GAP leader assignment");
  check(n.shift_team === "B" && n.shift_type === "NIGHT" && Number(n.gap_leader_assignment_id) === ids.b, "17. Mon 21:00 → team B NIGHT, snapshot = the line's B-shift GAP leader assignment");
  check(e.shift_team === "A" && e.shift_type === "NIGHT" && e.shift_operational_date === "2026-10-04" && Number(e.gap_leader_assignment_id) === ids.a, "Mon 07:59:59 → previous week's Sunday NIGHT (team A) → A leader");
  check(w.shift_team === "B" && w.shift_type === "DAY" && Number(w.gap_leader_assignment_id) === ids.b, "next week Mon 10:00 → swapped: team B DAY → B leader");
  check([d, n, e, w].every((x) => Number(x.supervisor_assignment_id) === ids.sv), "18. supervisor snapshot identical for team A and team B events");
  const ownA = await resolveLineOwnership("AP1-MAIN1", { shift: "A" });
  const ownB = await resolveLineOwnership("AP1-MAIN1", { shift: "B" });
  check(ownA?.supervisor?.userId === ownB?.supervisor?.userId && ownA?.currentGapLeader?.name === "리더-T1-A" && ownB?.currentGapLeader?.name === "리더-T1-B", "18. supervisor resolution independent of A/B; GAP leader follows the team");
  check([d, n, e, w].every((x) => x.department_code === "MT"), "responsible department unaffected by the shift (category routing)");
  const other = await shiftSnapshotForLine("BND-CE-BENDING", T("2026-10-05T21:00:00+09:00"));
  check(other.team === "B" && other.gapLeaderAssignmentId === (await asg("BND-CE-BENDING", "GAP_LEADER", "B")), "line-specific: another line resolves to ITS B leader");
  const noOwner = await shiftSnapshotForLine("AQ1-GPF", T("2026-10-05T10:00:00+09:00"));
  check(noOwner.status === "RESOLVED" && noOwner.team === "A" && noOwner.gapLeaderAssignmentId === null && noOwner.supervisorAssignmentId === null, "line without assignments: shift resolved, no leader reference (nothing invented)");

  // public API objects carry no schedule / anchor / ownership
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
  };
  walk(await getEvent(day.event.id));
  walk(await getMasterData());
  const leaked = [...keys].filter((k) => /anchor|shift|team|gapLeader|supervisor|assignment/i.test(k));
  check(leaked.length === 0, `public event / master-data objects expose no shift anchor, team or ownership fields (${keys.size} field names)`);
  check((await db.all("PRAGMA foreign_key_check")).length === 0, "foreign keys OK");
  void nowIso;
}

// ---------------------------------------------------------------- D) Turso-compatible v6 → v7

async function partD() {
  console.log("D) Turso-compatible migration v6 → v7 (remote driver on local libSQL, user_version writes rejected like Turso)");
  const { migrate, seedMasterData, schemaVersion, nowIso } = await import("../src/lib/server/db.ts");
  const { createClient } = await import("@libsql/client");
  const { RemoteDriver } = await import("../src/lib/server/sql.ts");
  const client = createClient({ url: "file:" + path.join(DIR, "turso-like.db").replaceAll("\\", "/") });
  const guard = <F extends (...a: never[]) => unknown>(fn: F): F =>
    ((...a: never[]) => (/PRAGMA\s+user_version\s*=/i.test(JSON.stringify(a[0])) ? Promise.reject(new Error("SQL_PARSE_ERROR: SQL not allowed statement")) : fn(...a))) as F;
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
  await migrate(d, undefined, 6);
  await d.transaction(() => seedMasterData(d)).catch(() => undefined); // v6 seed fails only on the v7 schedule row
  const now = nowIso();
  await d.exec(`
    INSERT OR IGNORE INTO plant (code, name, name_ko) VALUES ('YC', 'Yeongcheon', '영천');
    INSERT OR IGNORE INTO department (code, name_ko, name_en) VALUES ('MT', '보전', 'Maintenance');
    INSERT OR IGNORE INTO category (code, name_ko, name_en, default_department) VALUES ('MAINTENANCE', '설비', 'Maintenance', 'MT');
    INSERT OR IGNORE INTO line (code, name, plant_code) VALUES ('TGDI1', 'T-GDI 1', 'YC');
    INSERT INTO process (line_code, name) VALUES ('TGDI1', 'zz v6 process');
    INSERT INTO andon_event (id, plant, line_code, process_id, category_code, department_code, description, status, created_by, created_at, updated_at)
      VALUES ('AND-TEST-V6', 'Yeongcheon', 'TGDI1', (SELECT MAX(id) FROM process), 'MAINTENANCE', 'MT', '[TEST] v6 event', 'OPEN', 'test', '${now}', '${now}');
    INSERT INTO andon_transition (event_id, action, from_status, to_status, user_name, created_at) VALUES ('AND-TEST-V6', 'CREATE', NULL, 'OPEN', 'test', '${now}');
  `);
  check((await schemaVersion(d)) === 6, "remote-path database at v6 with an existing event");
  const old = JSON.stringify(await d.all("SELECT id, line_code, process_id, status, department_code, created_at FROM andon_event")) + JSON.stringify(await d.all("SELECT * FROM andon_transition"));
  await migrate(d, undefined, 7);
  await d.transaction(() => seedMasterData(d));
  check((await schemaVersion(d)) === 7, "migrated v6 → v7 through the remote driver (version in schema_meta)");
  const after = JSON.stringify(await d.all("SELECT id, line_code, process_id, status, department_code, created_at FROM andon_event")) + JSON.stringify(await d.all("SELECT * FROM andon_transition"));
  check(after === old, "existing event and history unchanged");
  const ev = await d.get("SELECT shift_status, shift_team, shift_type, gap_leader_assignment_id, supervisor_assignment_id FROM andon_event WHERE id = 'AND-TEST-V6'");
  check(Object.values(ev!).every((v) => v === null), "pre-v7 event: shift snapshot NULL (never back-filled)");
  const sch = await d.get("SELECT time_zone, day_start, night_start, rotation_weekday, anchor_week_monday, anchor_day_team FROM shift_schedule WHERE plant_code = 'YC'");
  check(sch?.time_zone === "Asia/Seoul" && sch.anchor_week_monday === null && sch.anchor_day_team === null, "schedule row seeded with the rule, anchor not set");
  check((await d.all("PRAGMA foreign_key_check")).length === 0 && (await d.run("UPDATE andon_transition SET comment = 'x'").then(() => false, () => true)), "foreign keys OK, history append-only");
  d.close();
}

// ---------------------------------------------------------------- C) HTTP (--http)

async function partC() {
  const { BASE, Client, admin, registerAccount } = await import("./lib/testkit.ts");
  console.log(`C) HTTP ${BASE}`);
  if (!SERVER_DB) throw new Error("part C needs DATABASE_PATH = the database of the server under test");
  process.env.DATABASE_PATH = path.resolve(SERVER_DB); // admin() CLI must target the SERVER database
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check(path.resolve(health.db) === path.resolve(SERVER_DB), "server under test uses DATABASE_PATH");
  const URL_ = "/api/admin/shift-schedule";
  check((await new Client("anon").request("GET", URL_)).status === 401, "GET without login → 401");
  const resp = await registerAccount("UAP", "shiftresp");
  check((await resp.client.request("GET", URL_)).status === 403, "self-registered RESPONDER → 403");
  const gl = await registerAccount("UAP", "shiftgl");
  admin("user", "role", String(gl.id), "GAP_LEADER");
  const glView = await gl.client.request("GET", URL_);
  const v = glView.body as { canEdit: boolean; rule: { timeZone: string }; now: { ok: boolean; code?: string }; audit: unknown[] };
  check(glView.status === 200 && v.canEdit === false && v.rule.timeZone === "Asia/Seoul", "GAP_LEADER may view (canEdit false)");
  check((await gl.client.request("PUT", URL_, { anchorWeekMonday: "2026-10-05", anchorDayTeam: "A" })).status === 403, "GAP_LEADER cannot change the anchor → 403");
  const sv = await registerAccount("UAP", "shiftsv");
  admin("user", "role", String(sv.id), "SUPERVISOR");
  const before = ((await sv.client.request("GET", URL_)).body as { audit: unknown[]; anchor: unknown }).audit.length;
  const bad = await sv.client.request("PUT", URL_, { anchorWeekMonday: "2026-10-07", anchorDayTeam: "A" });
  check(bad.status === 400 && (bad.body as { code: string }).code === "SHIFT_ANCHOR_INVALID", "SUPERVISOR: Wednesday as anchor → 400 SHIFT_ANCHOR_INVALID");
  check((await sv.client.request("PUT", URL_, { anchorWeekMonday: "2026-10-05", anchorDayTeam: "C" })).status === 400, "SUPERVISOR: team C → 400");
  const foreign = await sv.client.request("PUT", URL_, { anchorWeekMonday: "2026-10-05", anchorDayTeam: "A" }, { origin: "https://evil.example" });
  check(foreign.status === 403, "foreign Origin → 403");
  const ok = await sv.client.request("PUT", URL_, { anchorWeekMonday: "2026-10-05", anchorDayTeam: "B" });
  const ov = ok.body as { anchor: { anchorWeekMonday: string; anchorDayTeam: string }; now: { ok: boolean }; audit: { changedBy: string; source: string; new: { anchorDayTeam: string } }[] };
  check(ok.status === 200 && ov.anchor.anchorWeekMonday === "2026-10-05" && ov.anchor.anchorDayTeam === "B" && ov.now.ok === true, "SUPERVISOR sets a valid anchor → 200, current shift now resolvable");
  check(ov.audit.length === before + 1 && ov.audit[0].changedBy === sv.name && ov.audit[0].source === "WEB" && ov.audit[0].new.anchorDayTeam === "B", "change audited with the logged-in user's name, source WEB (rejected attempts not audited)");
  const metaKeys = Object.keys(await fetch(`${BASE}/api/meta`).then((r) => r.json()));
  check(!metaKeys.some((k) => /shift|anchor/i.test(k)), "/api/meta exposes no shift schedule / anchor");
  admin("user", "deactivate-test-accounts");
}

// ---------------------------------------------------------------- main

try {
  partA();
  await partB();
  await partD();
  if (process.argv.includes("--http")) await partC();
} catch (err) {
  check(false, `unexpected error: ${(err as Error).stack}`);
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
