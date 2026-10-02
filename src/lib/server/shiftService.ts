// Shift schedule (schema v7): configuration + anchor administration + shift context of a line.
// The calculation itself is the pure resolver in ../shiftSchedule.ts. This module never guesses a team:
// without an anchor every result is SHIFT_SCHEDULE_NOT_ANCHORED.
//
// Shift context is ACTOR ownership (which team / GAP leader / supervisor is on the line now). It is kept
// separate from the responsible department, which routing decides (routingService.ts).
import { db, nowIso } from "./db.ts";
import { AndonError } from "./errors.ts";
import {
  resolveShift,
  ShiftScheduleError,
  validateAnchor,
  type ResolvedShift,
  type ShiftAnchor,
  type ShiftRule,
  type ShiftTeam,
  type UnresolvedShift,
  type Weekday,
} from "../shiftSchedule.ts";

export const DEFAULT_PLANT = "YC";

export interface ShiftConfig {
  plantCode: string;
  rule: ShiftRule;
  anchor: ShiftAnchor;
  updatedAt: string | null;
  updatedBy: string | null;
}

export async function getShiftConfig(plantCode = DEFAULT_PLANT): Promise<ShiftConfig> {
  const r = await db.get("SELECT * FROM shift_schedule WHERE plant_code = ?", plantCode);
  if (!r) throw new AndonError(500, "shift schedule not configured for this plant", "SHIFT_SCHEDULE_MISSING");
  return {
    plantCode,
    rule: { timeZone: r.time_zone as string, dayStart: r.day_start as string, nightStart: r.night_start as string, rotationWeekday: r.rotation_weekday as Weekday },
    anchor: { anchorWeekMonday: (r.anchor_week_monday as string | null) ?? null, anchorDayTeam: (r.anchor_day_team as ShiftTeam | null) ?? null },
    updatedAt: (r.updated_at as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
  };
}

/** Shift on duty at `at` (default now) — SHIFT_SCHEDULE_NOT_ANCHORED until the anchor is set. */
export async function currentShift(at: string = nowIso(), plantCode = DEFAULT_PLANT): Promise<ResolvedShift | UnresolvedShift> {
  const c = await getShiftConfig(plantCode);
  return resolveShift(at, c.rule, c.anchor);
}

export interface AnchorActor {
  userId: number | null;
  name: string;
  source: "WEB" | "CLI";
  clientIp?: string | null;
  userAgent?: string | null;
}

/**
 * Sets the anchor (week Monday + DAY team) and writes an audit row (who, when, old, new) in the same
 * transaction. Validated before anything is written. Existing ANDON events are never touched: their
 * shift snapshot was taken at creation.
 */
export async function setShiftAnchor(anchor: ShiftAnchor, actor: AnchorActor, plantCode = DEFAULT_PLANT): Promise<{ changed: boolean; config: ShiftConfig }> {
  const before = await getShiftConfig(plantCode);
  try {
    validateAnchor(anchor, before.rule);
  } catch (e) {
    if (e instanceof ShiftScheduleError) throw new AndonError(400, e.message, e.code);
    throw e;
  }
  if (anchor.anchorWeekMonday === null) throw new AndonError(400, "anchor week and DAY team are required", "SHIFT_ANCHOR_INVALID");
  const same = before.anchor.anchorWeekMonday === anchor.anchorWeekMonday && before.anchor.anchorDayTeam === anchor.anchorDayTeam;
  if (same) return { changed: false, config: before };
  const now = nowIso();
  await db.transaction(async () => {
    const cur = await db.get("SELECT anchor_week_monday, anchor_day_team FROM shift_schedule WHERE plant_code = ?", plantCode);
    await db.run(
      "UPDATE shift_schedule SET anchor_week_monday = ?, anchor_day_team = ?, updated_at = ?, updated_by_user_id = ?, updated_by = ? WHERE plant_code = ?",
      anchor.anchorWeekMonday, anchor.anchorDayTeam, now, actor.userId, actor.name, plantCode,
    );
    await db.run(
      `INSERT INTO shift_schedule_audit (plant_code, changed_at, changed_by_user_id, changed_by, source, old_anchor_week_monday, old_anchor_day_team,
         new_anchor_week_monday, new_anchor_day_team, client_ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      plantCode, now, actor.userId, actor.name, actor.source, (cur?.anchor_week_monday as string | null) ?? null, (cur?.anchor_day_team as string | null) ?? null,
      anchor.anchorWeekMonday, anchor.anchorDayTeam, actor.clientIp ?? null, actor.userAgent ?? null,
    );
  });
  console.info(`[shift] anchor of ${plantCode} set by ${actor.source} user #${actor.userId ?? "-"}`);
  return { changed: true, config: await getShiftConfig(plantCode) };
}

export interface ShiftAuditRow {
  id: number;
  changedAt: string;
  changedBy: string;
  source: string;
  old: ShiftAnchor;
  new: ShiftAnchor;
}

export async function listShiftAudit(limit = 50, plantCode = DEFAULT_PLANT): Promise<ShiftAuditRow[]> {
  return (await db.all("SELECT * FROM shift_schedule_audit WHERE plant_code = ? ORDER BY id DESC LIMIT ?", plantCode, limit)).map((r) => ({
    id: Number(r.id),
    changedAt: r.changed_at as string,
    changedBy: r.changed_by as string,
    source: r.source as string,
    old: { anchorWeekMonday: (r.old_anchor_week_monday as string | null) ?? null, anchorDayTeam: (r.old_anchor_day_team as ShiftTeam | null) ?? null },
    new: { anchorWeekMonday: (r.new_anchor_week_monday as string | null) ?? null, anchorDayTeam: (r.new_anchor_day_team as ShiftTeam | null) ?? null },
  }));
}

/** Snapshot stored on a NEW ANDON event (columns andon_event.shift_* / *_assignment_id). */
export interface ShiftSnapshot {
  status: "RESOLVED" | "UNRESOLVED";
  unresolvedReason: string | null;
  team: ShiftTeam | null;
  type: "DAY" | "NIGHT" | null;
  operationalDate: string | null;
  startAt: string | null;
  gapLeaderAssignmentId: number | null;
  supervisorAssignmentId: number | null;
}

async function assignmentInForce(lineCode: string, role: "SUPERVISOR" | "GAP_LEADER", team: string | null, at: string): Promise<number | null> {
  const r = await db.get(
    `SELECT a.id FROM line_assignment a JOIN app_user u ON u.id = a.user_id
      WHERE a.line_code = ? AND a.assignment_role = ? AND IFNULL(a.shift_code, '-') = IFNULL(?, '-')
        AND a.active = 1 AND a.effective_from <= ? AND (a.effective_to IS NULL OR a.effective_to > ?) AND u.active = 1`,
    lineCode, role, team, at, at,
  );
  return r ? Number(r.id) : null;
}

/**
 * Shift context of a line at `at`. NEVER throws: any problem gives status UNRESOLVED with a reason, so an
 * ANDON call can never fail because of the shift schedule. The supervisor does not depend on A/B and is
 * resolved even when the shift is not.
 */
export async function shiftSnapshotForLine(lineCode: string, at: string): Promise<ShiftSnapshot> {
  const empty: ShiftSnapshot = { status: "UNRESOLVED", unresolvedReason: null, team: null, type: null, operationalDate: null, startAt: null, gapLeaderAssignmentId: null, supervisorAssignmentId: null };
  try {
    empty.supervisorAssignmentId = await assignmentInForce(lineCode, "SUPERVISOR", null, at);
  } catch {
    /* ownership tables unavailable — keep null */
  }
  try {
    const s = await currentShift(at);
    if (!s.ok) return { ...empty, unresolvedReason: s.code };
    return {
      ...empty,
      status: "RESOLVED",
      team: s.activeTeam,
      type: s.shiftType,
      operationalDate: s.operationalDate,
      startAt: s.shiftStart,
      gapLeaderAssignmentId: await assignmentInForce(lineCode, "GAP_LEADER", s.activeTeam, at),
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    console.error(`[shift] resolution failed for ${lineCode}: ${code ?? (err as Error).message}`);
    return { ...empty, unresolvedReason: code && /^SHIFT_/.test(code) ? code : "SHIFT_RESOLUTION_ERROR" };
  }
}

/** Shift shown on the public shop-floor display: team + DAY/NIGHT only (no anchor). Never throws. */
export type PublicShift = { status: "RESOLVED"; team: ShiftTeam; type: "DAY" | "NIGHT"; operationalDate: string; shiftEnd: string } | { status: "UNRESOLVED"; reason: string };

export async function publicShift(at: string = nowIso()): Promise<PublicShift> {
  try {
    const s = await currentShift(at);
    if (!s.ok) return { status: "UNRESOLVED", reason: s.code };
    return { status: "RESOLVED", team: s.activeTeam, type: s.shiftType, operationalDate: s.operationalDate, shiftEnd: s.shiftEnd };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { status: "UNRESOLVED", reason: code && /^SHIFT_/.test(code) ? code : "SHIFT_RESOLUTION_ERROR" };
  }
}
