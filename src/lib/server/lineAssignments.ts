// Line ownership: which employee is the SUPERVISOR of a line and which employee is its GAP LEADER per
// shift (A / B). Schema v6, table line_assignment. This is ACTOR ownership (who owns the line), not the
// responsible department of an ANDON — that stays with routing_rule / category (routingService.ts).
//
// Shift clock times are not confirmed yet, so nothing here decides which shift is on duty: callers get
// both shifts' GAP leaders, and `currentGapLeader` only when they pass the shift explicitly.
import { db, nowIso } from "./db.ts";
import { AndonError } from "./errors.ts";
import type { LineOwnership, LineOwnershipList } from "../domain.ts";

export const ASSIGNMENT_ROLES = ["SUPERVISOR", "GAP_LEADER"] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export type { LineOwnership, LinePerson } from "../domain.ts";

async function shiftCodes(): Promise<string[]> {
  return (await db.all("SELECT code FROM shift WHERE active = 1 ORDER BY sort_order")).map((r) => r.code as string);
}

/** Every line (optionally one) with the assignments IN FORCE at ?1: active, inside effective_from /
 *  effective_to, employee active. Inactive / ended assignments are ignored; lines without one appear once. */
async function ownershipRows(at: string, lineCode: string | null) {
  return db.all(
    `SELECT l.code AS line_code, l.name AS line_name, l.uap_area_code, l.active AS line_active,
            x.assignment_role, x.shift_code, x.user_id, x.user_name
       FROM line l
       LEFT JOIN (
         SELECT a.line_code, a.assignment_role, a.shift_code, u.id AS user_id, u.name AS user_name
           FROM line_assignment a JOIN app_user u ON u.id = a.user_id
          WHERE a.active = 1 AND a.effective_from <= ?1 AND (a.effective_to IS NULL OR a.effective_to > ?1) AND u.active = 1
       ) x ON x.line_code = l.code
      WHERE (?2 IS NULL OR l.code = ?2)
      ORDER BY l.sort_order, l.code`,
    at,
    lineCode,
  );
}

function build(rows: Awaited<ReturnType<typeof ownershipRows>>, shifts: string[], shift: string | null): LineOwnership[] {
  const byLine = new Map<string, LineOwnership>();
  for (const r of rows) {
    const code = r.line_code as string;
    let o = byLine.get(code);
    if (!o) {
      o = {
        lineCode: code,
        lineName: r.line_name as string,
        uapAreaCode: (r.uap_area_code as string | null) ?? null,
        lineActive: r.line_active === 1,
        supervisor: null,
        gapLeaders: Object.fromEntries(shifts.map((s) => [s, null])),
        shift,
        currentGapLeader: null,
      };
      byLine.set(code, o);
    }
    if (r.user_id == null) continue;
    const person = { userId: Number(r.user_id), name: r.user_name as string };
    if (r.assignment_role === "SUPERVISOR") o.supervisor = person;
    else if (r.assignment_role === "GAP_LEADER") o.gapLeaders[r.shift_code as string] = person;
  }
  for (const o of byLine.values()) o.currentGapLeader = shift ? (o.gapLeaders[shift] ?? null) : null;
  return [...byLine.values()];
}

/**
 * Line → Supervisor + GAP leader of each shift, as in force at `at` (default now).
 * `shift` (A / B) selects currentGapLeader; without it currentGapLeader is null (shift unknown).
 * Returns null for an unknown line.
 */
export async function resolveLineOwnership(lineCode: string, opts: { at?: string; shift?: string | null } = {}): Promise<LineOwnership | null> {
  const shifts = await shiftCodes();
  const shift = opts.shift ?? null;
  if (shift !== null && !shifts.includes(shift)) throw new AndonError(400, `unknown shift ${shift}`, "INVALID_SHIFT");
  return build(await ownershipRows(opts.at ?? nowIso(), lineCode), shifts, shift)[0] ?? null;
}

/** Ownership of every line (admin view), in line order. */
export async function listLineOwnership(at: string = nowIso()): Promise<LineOwnershipList> {
  const shiftRows = await db.all("SELECT code, name_ko, start_time, end_time FROM shift WHERE active = 1 ORDER BY sort_order");
  const shifts = shiftRows.map((r) => r.code as string);
  return {
    shifts: shiftRows.map((r) => ({ code: r.code as string, nameKo: r.name_ko as string, startTime: (r.start_time as string | null) ?? null, endTime: (r.end_time as string | null) ?? null })),
    areas: (await db.all("SELECT code, name FROM uap_area WHERE active = 1 ORDER BY sort_order")).map((r) => ({ code: r.code as string, name: r.name as string })),
    lines: build(await ownershipRows(at, null), shifts, null),
  };
}

// ---------------------------------------------------------------- workbook import

/** One line of the plant organization as read from the workbook (names only). */
export interface OrgLine {
  lineName: string;
  uapAreaCode: string;
  supervisor: string;
  gapLeaders: Record<string, string | null>;
}

export interface ImportReport {
  employeesCreated: number;
  employeesReused: number;
  assignmentsCreated: number;
  assignmentsUnchanged: number;
  assignmentsEnded: number;
  warnings: string[];
}

const normName = (s: string) => s.replace(/\s+/g, " ").trim();
export const importKey = (name: string) => `WORKBOOK:UAP:${normName(name)}`;

/**
 * Applies the workbook organization to line_assignment in ONE transaction (all or nothing):
 *  - one app_user per person (key app_user.import_key) — reused when it already exists, so a person
 *    covering several lines, or a repeated import, never creates a duplicate employee;
 *  - per line and slot (SUPERVISOR, GAP_LEADER A, GAP_LEADER B): unchanged assignments are kept; a
 *    different person ends the old assignment (effective_to = now, active = 0) and starts a new one;
 *    a slot no longer in the workbook is ended. Ended rows stay as history.
 * Lines must already exist in the line master (matched by exact name within the UAP area).
 */
export async function applyOrgImport(org: OrgLine[], sourceRef: string): Promise<ImportReport> {
  const report: ImportReport = { employeesCreated: 0, employeesReused: 0, assignmentsCreated: 0, assignmentsUnchanged: 0, assignmentsEnded: 0, warnings: [] };
  const shifts = await shiftCodes();
  return db.transaction(async () => {
    const now = nowIso();
    // ---- resolve lines
    const lineCodes = new Map<OrgLine, string>();
    const seen = new Set<string>();
    for (const ol of org) {
      const rows = await db.all("SELECT code FROM line WHERE name = ? AND uap_area_code = ?", normName(ol.lineName), ol.uapAreaCode);
      if (rows.length !== 1) throw new AndonError(400, `line "${ol.lineName}" (${ol.uapAreaCode}) not found exactly once in the line master`, "UNKNOWN_LINE");
      const code = rows[0].code as string;
      if (seen.has(code)) throw new AndonError(400, `line "${ol.lineName}" appears twice in the import`, "DUPLICATE_LINE");
      seen.add(code);
      lineCodes.set(ol, code);
      for (const s of Object.keys(ol.gapLeaders)) if (!shifts.includes(s)) throw new AndonError(400, `unknown shift ${s}`, "INVALID_SHIFT");
    }
    // ---- resolve people (one employee per person)
    const roleOf = new Map<string, "SUPERVISOR" | "GAP_LEADER">();
    for (const ol of org) {
      const wanted: [string, "SUPERVISOR" | "GAP_LEADER"][] = [[ol.supervisor, "SUPERVISOR"]];
      for (const n of Object.values(ol.gapLeaders)) if (n) wanted.push([n, "GAP_LEADER"]);
      for (const [n, role] of wanted) {
        const key = normName(n);
        const prev = roleOf.get(key);
        if (prev && prev !== role) throw new AndonError(400, `"${key}" is both SUPERVISOR and GAP_LEADER in the workbook`, "AMBIGUOUS_PERSON");
        roleOf.set(key, role);
      }
    }
    const userIds = new Map<string, number>();
    for (const [name, role] of roleOf) {
      const existing = await db.get("SELECT id, role, active FROM app_user WHERE import_key = ?", importKey(name));
      if (existing) {
        report.employeesReused++;
        userIds.set(name, Number(existing.id));
        if (existing.active !== 1) report.warnings.push(`employee #${existing.id} (${name}) is inactive — assignments are kept but ignored`);
        if (existing.role !== role) report.warnings.push(`employee #${existing.id} (${name}) has role ${existing.role as string}, workbook says ${role} — role not changed`);
        continue;
      }
      const r = await db.run(
        `INSERT INTO app_user (name, department_code, role, active, source, created_at, import_key) VALUES (?, 'UAP', ?, 1, 'ADMIN', ?, ?)`,
        name, role, now, importKey(name),
      );
      report.employeesCreated++;
      userIds.set(name, Number(r.lastInsertRowid));
    }
    // ---- assignments per line and slot
    for (const ol of org) {
      const line = lineCodes.get(ol)!;
      const slots: { role: AssignmentRole; shift: string | null; userId: number | null }[] = [
        { role: "SUPERVISOR", shift: null, userId: userIds.get(normName(ol.supervisor)) ?? null },
        ...shifts.map((s) => ({ role: "GAP_LEADER" as const, shift: s, userId: ol.gapLeaders[s] ? userIds.get(normName(ol.gapLeaders[s]!))! : null })),
      ];
      for (const slot of slots) {
        const current = await db.get(
          "SELECT id, user_id FROM line_assignment WHERE line_code = ? AND assignment_role = ? AND IFNULL(shift_code, '-') = IFNULL(?, '-') AND active = 1",
          line, slot.role, slot.shift,
        );
        if (current && slot.userId !== null && Number(current.user_id) === slot.userId) {
          report.assignmentsUnchanged++;
          continue;
        }
        if (current) {
          await db.run("UPDATE line_assignment SET active = 0, effective_to = ? WHERE id = ?", now, current.id as number);
          report.assignmentsEnded++;
        }
        if (slot.userId !== null) {
          await db.run(
            `INSERT INTO line_assignment (line_code, user_id, assignment_role, shift_code, effective_from, active, source, source_ref, created_at)
             VALUES (?, ?, ?, ?, ?, 1, 'WORKBOOK', ?, ?)`,
            line, slot.userId, slot.role, slot.shift, now, sourceRef, now,
          );
          report.assignmentsCreated++;
        }
      }
    }
    return report;
  });
}
