// Shop-floor plant map — PURE display logic (no React, no DB), shared by /dashboard and test:display.
// Line state = most urgent ACTIVE event on the line: OPEN (red) > ACKNOWLEDGED / IN_PROGRESS (amber).
// CLOSED events never make a line abnormal. No escalation thresholds here (none approved by the plant).
import { STATION_CELLS, stationBox, type StationCell } from "../config/plantLayout.ts";
import type { AndonEvent, AndonStatus } from "./domain.ts";

export type LineVisualState = "NORMAL" | "OPEN" | "ACTION";

const ACTIVE: readonly AndonStatus[] = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"];
export const isActive = (e: Pick<AndonEvent, "status">) => ACTIVE.includes(e.status);

export function elapsedSeconds(e: Pick<AndonEvent, "createdAt" | "closedAt">, nowMs: number): number {
  const end = e.closedAt ? new Date(e.closedAt).getTime() : nowMs;
  return Math.max(0, Math.floor((end - new Date(e.createdAt).getTime()) / 1000));
}

/** "04:32", "1:02:05" */
export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Active events, most urgent first: OPEN before ACK / IN_PROGRESS, then longest elapsed (oldest). */
export function sortActive<T extends Pick<AndonEvent, "status" | "createdAt">>(events: T[]): T[] {
  return events
    .filter(isActive)
    .slice()
    .sort((a, b) => (a.status === "OPEN" ? 0 : 1) - (b.status === "OPEN" ? 0 : 1) || a.createdAt.localeCompare(b.createdAt));
}

export interface LineState {
  state: LineVisualState;
  /** Number of active events on the line (badge when > 1). */
  count: number;
  /** The event shown on the tile: most urgent, then oldest. */
  lead: AndonEvent | null;
}

export function lineStates(events: AndonEvent[]): Map<string, LineState> {
  const out = new Map<string, LineState>();
  for (const e of sortActive(events)) {
    const cur = out.get(e.lineCode);
    if (cur) cur.count++;
    else out.set(e.lineCode, { state: e.status === "OPEN" ? "OPEN" : "ACTION", count: 1, lead: e });
  }
  return out;
}

/**
 * State of a station: its line plus alias lines (see StationCell.aliasLineCodes) merged — most urgent
 * state, summed count, lead = most urgent then oldest event of all of them.
 */
export function stationState(codes: string[], states: Map<string, LineState>): LineState | undefined {
  const parts = codes.map((c) => states.get(c)).filter((x): x is LineState => !!x);
  if (parts.length === 0) return undefined;
  const lead = sortActive(parts.map((p) => p.lead!))[0];
  return { state: parts.some((p) => p.state === "OPEN") ? "OPEN" : "ACTION", count: parts.reduce((n, p) => n + p.count, 0), lead };
}

export interface MapLine {
  code: string;
  name: string;
}

/** Lines the display shows: REAL plant lines only (with a UAP area). Prototype / demo lines appear only
 *  while they have an active event (see placeLines). */
export function displayLines(lines: { code: string; name: string; uapAreaCode: string | null }[]): MapLine[] {
  return lines.filter((l) => l.uapAreaCode).map((l) => ({ code: l.code, name: l.name }));
}

export interface Placement {
  cell: StationCell;
  box: { x: number; y: number; w: number; h: number };
  /** Linked DB line (confirmed only); null = layout station without a confirmed line (drawn faintly). */
  line: MapLine | null;
}

/**
 * Stations of the plant drawing with their confirmed lines, plus the lines that are NOT on the map:
 * active master lines without a confirmed station, and any line with an active event that is not
 * placed (e.g. a hidden prototype line with an old open event) — an abnormality is never hidden.
 */
export function placeLines(lines: MapLine[], events: AndonEvent[] = [], cells: StationCell[] = STATION_CELLS): { stations: Placement[]; unplaced: MapLine[] } {
  const byCode = new Map(lines.map((l) => [l.code, l]));
  const stations = cells.map((cell) => ({ cell, box: stationBox(cell), line: cell.lineCode ? (byCode.get(cell.lineCode) ?? null) : null }));
  const placed = new Set(stations.filter((s) => s.line).flatMap((s) => [s.line!.code, ...(s.cell.aliasLineCodes ?? [])]));
  const unplaced = lines.filter((l) => !placed.has(l.code));
  const extra = new Map<string, MapLine>();
  for (const e of events) {
    if (isActive(e) && !placed.has(e.lineCode) && !byCode.has(e.lineCode)) extra.set(e.lineCode, { code: e.lineCode, name: e.lineName });
  }
  return { stations, unplaced: [...unplaced, ...extra.values()] };
}

/** Public shift chip text — never infers a team. */
export function shiftLabel(shift: { status: "RESOLVED"; team: "A" | "B"; type: "DAY" | "NIGHT" } | { status: "UNRESOLVED" } | null | undefined): string {
  if (!shift || shift.status !== "RESOLVED") return "SHIFT: UNRESOLVED";
  return `SHIFT ${shift.team} · ${shift.type}`;
}
