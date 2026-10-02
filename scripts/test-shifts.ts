// A/B shift schedule tests (npm run test:shifts). Fixed timestamps only — never the real current date.
// The anchor used here (week of Monday 2026-10-05, DAY team A) is a TEST VALUE, not the plant's anchor.
//
// A) pure resolver matrix (Asia/Seoul, boundaries, weekly swap, DST independence, anchor validation)
import { resolveShift, YEONGCHEON_SHIFT_RULE as RULE, type ResolvedShift, type ShiftAnchor } from "../src/lib/shiftSchedule.ts";

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

export function partA() {
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

export function finish(): never {
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
export { check };

if (import.meta.main) {
  partA();
  finish();
}
