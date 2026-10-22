// Temporary showcase mode (plant request 2026-10-22, EVP tour 2026-10-23 08:00–12:00 KST).
// DISPLAY ONLY — nothing in the database changes, every record stays and comes back when the window ends:
//  - board / history lists and statistics leave out ANDONs that ran (or have been running) over 2 h
//  - the shop-floor side list shows at most 6 items, none over 1 h (the client reads `showcase` on the board)
// Work screens (respond, notifications, escalation) are never filtered. The window ends by itself.
// Local tests may set SHOWCASE_WINDOW="<from ISO>,<to ISO>".
import type { AndonEvent } from "../domain.ts";

const WINDOW = (process.env.SHOWCASE_WINDOW ?? "2026-10-22T23:00:00.000Z,2026-10-23T03:00:00.000Z").split(",");
export const SHOWCASE_HIDE_OVER_MS = 2 * 3600_000;
export const SHOWCASE_LIST = { maxAgeMs: 3600_000, max: 6 };

export function showcaseActive(now = Date.now()): boolean {
  const from = Date.parse(WINDOW[0] ?? ""), to = Date.parse(WINDOW[1] ?? "");
  return Number.isFinite(from) && Number.isFinite(to) && now >= from && now < to;
}

/** How long the ANDON ran: until it was closed, or until now while it is still open. */
const ranMs = (e: AndonEvent, now: number) => (e.closedAt ? Date.parse(e.closedAt) : now) - Date.parse(e.createdAt);

export function showcaseFilter(events: AndonEvent[], now = Date.now()): AndonEvent[] {
  return showcaseActive(now) ? events.filter((e) => ranMs(e, now) <= SHOWCASE_HIDE_OVER_MS) : events;
}
