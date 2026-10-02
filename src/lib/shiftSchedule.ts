// A/B shift schedule — PURE resolver (no database, no server clock, no process time zone).
//
// Confirmed Yeongcheon UAP rule (2026-10-02):
//   - two 12-hour shifts: DAY 08:00–20:00, NIGHT 20:00–08:00 (plant time zone Asia/Seoul)
//   - teams A and B alternate DAY / NIGHT weekly; the rotation boundary is the DAY shift that starts
//     MONDAY 08:00 (not Monday 00:00): Monday 00:00–07:59:59 still belongs to the previous week's
//     Sunday NIGHT shift
//   - which team has DAY in a given week needs ONE anchor fact (anchor Monday + its DAY team). Without
//     it the resolver returns SHIFT_SCHEDULE_NOT_ANCHORED — it never picks A or B by itself.
//
// A shift belongs to the operational date / week of its START. All wall-clock math is done in the
// plant time zone via Intl, never with Date's local-time getters (server / Vercel run in UTC).

export type ShiftType = "DAY" | "NIGHT";
export type ShiftTeam = "A" | "B";
export const SHIFT_TEAMS: readonly ShiftTeam[] = ["A", "B"];
const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface ShiftRule {
  timeZone: string; // "Asia/Seoul"
  dayStart: string; // "08:00" — DAY starts (inclusive)
  nightStart: string; // "20:00" — NIGHT starts (inclusive); must be dayStart + 12 h
  rotationWeekday: Weekday; // "MONDAY" — the week starts with this weekday's DAY shift
}
export interface ShiftAnchor {
  anchorWeekMonday: string | null; // YYYY-MM-DD, a rotation weekday (Monday)
  anchorDayTeam: ShiftTeam | null; // team on DAY shift in that week
}

export const YEONGCHEON_SHIFT_RULE: ShiftRule = { timeZone: "Asia/Seoul", dayStart: "08:00", nightStart: "20:00", rotationWeekday: "MONDAY" };

export interface ResolvedShift {
  ok: true;
  /** Plant-local date on which the current shift STARTED (YYYY-MM-DD). */
  operationalDate: string;
  shiftType: ShiftType;
  /** ISO timestamps with the plant offset, e.g. 2026-10-05T08:00:00+09:00 */
  shiftStart: string;
  shiftEnd: string;
  /** First day (rotation weekday) of the operational week, YYYY-MM-DD. */
  rotationWeekStart: string;
  /** Weeks since the anchor week (negative = before). Even = same DAY team as the anchor. */
  rotationWeek: number;
  dayTeam: ShiftTeam;
  nightTeam: ShiftTeam;
  activeTeam: ShiftTeam;
  /** = shiftEnd: next DAY/NIGHT change. */
  nextChangeAt: string;
  /** Next weekly A/B swap: next rotation weekday at dayStart. */
  nextRotationAt: string;
}
export interface UnresolvedShift {
  ok: false;
  code: "SHIFT_SCHEDULE_NOT_ANCHORED";
  message: string;
}

export class ShiftScheduleError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const DAY_MS = 86_400_000;
const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");

function parseHm(s: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new ShiftScheduleError("SHIFT_RULE_INVALID", `invalid time "${s}" (HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Validates a YYYY-MM-DD calendar date; returns its day number (days since 1970-01-01). */
function dayNumber(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new ShiftScheduleError("SHIFT_ANCHOR_INVALID", `anchor week must be a date YYYY-MM-DD (got "${date}")`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new ShiftScheduleError("SHIFT_ANCHOR_INVALID", `"${date}" is not a calendar date`);
  }
  return ms / DAY_MS;
}
const dateOf = (dayNo: number) => new Date(dayNo * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (dayNo: number) => new Date(dayNo * DAY_MS).getUTCDay(); // 0 = Sunday

/** Wall-clock parts of an instant in `timeZone` (Intl — independent of the process time zone). */
function wallClock(instantMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** Offset (ms) of `timeZone` at an instant: local wall time − UTC. */
function offsetAt(instantMs: number, timeZone: string): number {
  const w = wallClock(instantMs, timeZone);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Plant wall time (day number + minutes) → ISO string with the zone's offset at that moment. */
function isoAt(dayNo: number, minutes: number, timeZone: string): string {
  const localMs = dayNo * DAY_MS + minutes * 60_000;
  const off = offsetAt(localMs - offsetAt(localMs, timeZone), timeZone);
  const sign = off < 0 ? "-" : "+";
  const offMin = Math.abs(off) / 60_000;
  return `${new Date(localMs).toISOString().slice(0, 19)}${sign}${pad(Math.floor(offMin / 60))}:${pad(offMin % 60)}`;
}

/** Throws ShiftScheduleError when the rule is unusable (wrong times / weekday / time zone). */
export function validateRule(rule: ShiftRule): { dayMin: number; nightMin: number; rotationDow: number } {
  const dayMin = parseHm(rule.dayStart);
  const nightMin = parseHm(rule.nightStart);
  if (nightMin - dayMin !== 12 * 60) throw new ShiftScheduleError("SHIFT_RULE_INVALID", "NIGHT must start 12 hours after DAY (two 12-hour shifts)");
  const rotationDow = WEEKDAYS.indexOf(rule.rotationWeekday);
  if (rotationDow < 0) throw new ShiftScheduleError("SHIFT_RULE_INVALID", `invalid rotation weekday ${rule.rotationWeekday}`);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: rule.timeZone });
  } catch {
    throw new ShiftScheduleError("SHIFT_RULE_INVALID", `unknown time zone ${rule.timeZone}`);
  }
  return { dayMin, nightMin, rotationDow };
}

/** Throws ShiftScheduleError SHIFT_ANCHOR_INVALID; null/null (not configured) is valid. */
export function validateAnchor(anchor: ShiftAnchor, rule: ShiftRule = YEONGCHEON_SHIFT_RULE): void {
  const { rotationDow } = validateRule(rule);
  if (anchor.anchorWeekMonday === null && anchor.anchorDayTeam === null) return;
  if (anchor.anchorWeekMonday === null || anchor.anchorDayTeam === null) {
    throw new ShiftScheduleError("SHIFT_ANCHOR_INVALID", "anchor week and DAY team must be set together");
  }
  const dn = dayNumber(anchor.anchorWeekMonday);
  if (weekdayOf(dn) !== rotationDow) throw new ShiftScheduleError("SHIFT_ANCHOR_INVALID", `anchor week must start on a ${rule.rotationWeekday} (${anchor.anchorWeekMonday} is not)`);
  if (!SHIFT_TEAMS.includes(anchor.anchorDayTeam)) throw new ShiftScheduleError("SHIFT_ANCHOR_INVALID", "anchor DAY team must be A or B");
}

/**
 * Shift on duty at `at` (Date, epoch ms or ISO string with offset). Returns SHIFT_SCHEDULE_NOT_ANCHORED
 * when no anchor is configured; throws ShiftScheduleError for an invalid rule / anchor / timestamp.
 */
export function resolveShift(at: Date | number | string, rule: ShiftRule, anchor: ShiftAnchor): ResolvedShift | UnresolvedShift {
  const { dayMin, nightMin, rotationDow } = validateRule(rule);
  validateAnchor(anchor, rule);
  const ms = typeof at === "number" ? at : new Date(at).getTime();
  if (!Number.isFinite(ms)) throw new ShiftScheduleError("SHIFT_TIME_INVALID", "invalid timestamp");
  if (anchor.anchorWeekMonday === null || anchor.anchorDayTeam === null) {
    return { ok: false, code: "SHIFT_SCHEDULE_NOT_ANCHORED", message: "A/B shift anchor (anchor week + DAY team) is not configured" };
  }

  const w = wallClock(ms, rule.timeZone);
  const today = Date.UTC(w.y, w.mo - 1, w.d) / DAY_MS;
  const minute = w.h * 60 + w.mi; // seconds never cross a boundary: 07:59:59 < 08:00
  let opDay: number;
  let shiftType: ShiftType;
  let startMin: number;
  if (minute < dayMin) {
    opDay = today - 1; // night shift that started yesterday evening
    shiftType = "NIGHT";
    startMin = nightMin;
  } else if (minute < nightMin) {
    opDay = today;
    shiftType = "DAY";
    startMin = dayMin;
  } else {
    opDay = today;
    shiftType = "NIGHT";
    startMin = nightMin;
  }
  const weekStart = opDay - ((weekdayOf(opDay) - rotationDow + 7) % 7);
  const rotationWeek = Math.round((weekStart - dayNumber(anchor.anchorWeekMonday)) / 7);
  const other: ShiftTeam = anchor.anchorDayTeam === "A" ? "B" : "A";
  const dayTeam = rotationWeek % 2 === 0 ? anchor.anchorDayTeam : other;
  const nightTeam: ShiftTeam = dayTeam === "A" ? "B" : "A";
  const shiftStart = isoAt(opDay, startMin, rule.timeZone);
  const shiftEnd = isoAt(opDay, startMin + 12 * 60, rule.timeZone);
  return {
    ok: true,
    operationalDate: dateOf(opDay),
    shiftType,
    shiftStart,
    shiftEnd,
    rotationWeekStart: dateOf(weekStart),
    rotationWeek,
    dayTeam,
    nightTeam,
    activeTeam: shiftType === "DAY" ? dayTeam : nightTeam,
    nextChangeAt: shiftEnd,
    nextRotationAt: isoAt(weekStart + 7, dayMin, rule.timeZone),
  };
}
