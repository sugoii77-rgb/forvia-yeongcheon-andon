// Shop-floor plant-map display tests (npm run test:display). Fixed timestamps; no production data.
// A) layout config: every real line is on exactly one confirmed station OR explicitly unmapped; no
//    duplicate ids / lines, no overlapping or out-of-frame boxes, codes exist in the line master
// B) pure display logic: OPEN → red, ACK / IN_PROGRESS → amber, CLOSED → normal, several events on
//    one line (count + most urgent lead), active-list order, elapsed timer, unresolved shift never
//    shows A/B, demo lines hidden unless they carry an active event
// C) --http (BASE_URL of an ISOLATED server): board API shift without team / anchor, no personnel /
//    contact fields in public responses, demo-line history still served, /dashboard renders
import { LINES } from "../src/lib/server/masterData.ts";
import { MAP_LANDMARKS, MAP_ZONES, STATION_CELLS, UNMAPPED_LINES, stationBox } from "../src/config/plantLayout.ts";
import { CATEGORY_LEGEND, categoryKey, displayLines, stationState, elapsedSeconds, formatElapsed, lineStates, placeLines, shiftLabel, sortActive } from "../src/lib/plantMap.ts";
import type { AndonEvent, AndonStatus } from "../src/lib/domain.ts";

let failures = 0;
function check(cond: unknown, label: string) {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.log(`  ✖ ${label}`);
  }
}

const REAL = LINES.filter((l) => l.uapAreaCode);
const DEMO = LINES.filter((l) => !l.uapAreaCode);

function partA() {
  console.log("A) Plant layout configuration");
  const linked = STATION_CELLS.filter((c) => c.lineCode).map((c) => c.lineCode!);
  const unmapped = Object.keys(UNMAPPED_LINES);
  check(REAL.every((l) => linked.filter((x) => x === l.code).length + unmapped.filter((x) => x === l.code).length === 1), `every real line (${REAL.length}) is on exactly one station or explicitly unmapped: ${linked.length} mapped + ${unmapped.length} unmapped`);
  check(linked.length + unmapped.length === REAL.length, "mapped + unmapped = all real lines");
  check([...linked, ...unmapped].every((c) => REAL.some((l) => l.code === c)), "every referenced code exists in the real line master");
  check(!DEMO.some((d) => linked.includes(d.code) || unmapped.includes(d.code)), "demo lines (T-GDI 1, T-GDI 2, Muffler 1) are not placed on the map as their own station");
  const aliases = STATION_CELLS.flatMap((c) => c.aliasLineCodes ?? []);
  check(aliases.every((a) => LINES.some((l) => l.code === a) && !linked.includes(a)) && new Set(aliases).size === aliases.length, "alias lines exist, are not linked elsewhere, at most one station each");
  check(STATION_CELLS.find((c) => c.id === "KAPPA-EU7")?.aliasLineCodes?.includes("TGDI1"), "plant decision: T-GDI 1 (prototype) = GAMMA T-GDI 1차 → lights the KAPPA EU7 station");
  check(STATION_CELLS.find((c) => c.id === "GAMMA2-TGDI")?.aliasLineCodes?.includes("TGDI2"), "plant decision: T-GDI 2 (prototype) = GAMMA T-GDI 2차 → lights the TURBO#1 station");
  check(new Set(STATION_CELLS.map((c) => c.id)).size === STATION_CELLS.length, "no duplicate station ids");
  check(new Set(linked).size === linked.length, "no line linked to two stations");
  check(STATION_CELLS.every((c) => !c.lineCode || c.match), "every confirmed link states how it was matched");
  check(STATION_CELLS.find((c) => c.id === "KAPPA-EU7")?.lineCode === "AQ2-TURBO2-EU7" && STATION_CELLS.find((c) => c.id === "GPF")?.lineCode === "AQ1-GPF" && STATION_CELLS.find((c) => c.id === "GAMMA2-TGDI")?.lineCode === "AQ2-TURBO1", "plant decisions: KAPPA EU7 station = TURBO #2 EU7, GAMMA2 T-GDI station = TURBO#1, GPF station = GPF");
  const decided: Record<string, string> = { "NX4-2": "AP1-NX4-CTR2", "JX-ASSY1": "AP2-JX-ASSY", "LAMBDA-FRT": "AP2-JX-LAMBDA-FRT", "FORMING-CUTTING": "BND-PIPE-CUTTING", "NX4JX-LOCKSEAM": "RESO-LOCKSEAM", "QX-MAIN-RESO": "RESO-QX", "SX2-MAIN-RESO": "RESO-SX2" };
  check(Object.entries(decided).every(([id, code]) => { const c = STATION_CELLS.find((x) => x.id === id); return c?.lineCode === code && c.match === "PLANT_DECISION" && c.subLabel === c.layoutLabel; }), "plant decisions: 7 lines with a different drawing name placed on their candidate station (drawing name shown)");
  check(STATION_CELLS.filter((c) => c.candidateLineCode).every((c) => !c.lineCode && unmapped.includes(c.candidateLineCode!)), "candidate (unconfirmed) stations are not linked and their lines are in the unmapped list");
  check(Object.values(UNMAPPED_LINES).every((u) => u.candidateStation === null || STATION_CELLS.some((c) => c.id === u.candidateStation)), "unmapped candidates point to existing stations");
  const boxes = STATION_CELLS.map((c) => ({ id: c.id, ...stationBox(c) }));
  const inFrame = boxes.every((b) => b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 100 && b.y + b.h <= 100);
  const key = (b: { x: number; y: number; w: number; h: number }) => `${b.x}|${b.y}|${b.w}|${b.h}`;
  const overlaps: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01) overlaps.push(`${a.id}/${b.id}`);
    }
  check(inFrame && new Set(boxes.map(key)).size === boxes.length, "all station boxes inside the 100 × 100 frame, no duplicate coordinates");
  check(overlaps.length === 0, `no overlapping stations${overlaps.length ? `: ${overlaps.join(", ")}` : ""}`);
  check([...MAP_ZONES, ...MAP_LANDMARKS].every((z) => z.x >= 0 && z.y >= 0 && z.x + z.w <= 100.01 && z.y + z.h <= 100.01), "zones and landmarks inside the frame");
}

// ---------------------------------------------------------------- B) logic

let seq = 0;
function ev(lineCode: string, status: AndonStatus, createdAt: string, closedAt: string | null = null): AndonEvent {
  seq++;
  return {
    id: `AND-TEST-${seq}`, plant: "Yeongcheon", lineCode, lineName: lineCode, processId: 1, processName: "p", categoryCode: "QUALITY", categoryName: "품질",
    departmentCode: "QC", departmentName: "품질", departmentLabel: "QC · 품질", departments: [{ code: "QC", label: "QC · 품질" }], situations: [], description: "test", photoFile: null, status, createdBy: "op",
    createdAt, acknowledgedAt: null, acknowledgedBy: null, closedAt, closedBy: null, correctiveAction: null, updatedAt: createdAt,
  };
}

function partB() {
  console.log("B) Display logic (fixed timestamps)");
  const NOW = Date.parse("2026-10-05T10:00:00+09:00");
  const t = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const events = [
    ev("AQ2-GAMMA2", "OPEN", t(12)),
    ev("AP1-MAIN1", "ACKNOWLEDGED", t(30)),
    ev("RESO-CTR", "IN_PROGRESS", t(5)),
    ev("AQ2-KAPPA16", "CLOSED", t(40), t(10)),
    ev("AQ1-NUI1", "ACKNOWLEDGED", t(20)),
    ev("AQ1-NUI1", "OPEN", t(3)),
    ev("AQ1-NUI1", "OPEN", t(8)),
  ];
  const st = lineStates(events);
  check(st.get("AQ2-GAMMA2")?.state === "OPEN", "OPEN event → line red (OPEN)");
  check(st.get("AP1-MAIN1")?.state === "ACTION" && st.get("RESO-CTR")?.state === "ACTION", "ACKNOWLEDGED / IN_PROGRESS → amber (ACTION)");
  check(st.get("AQ2-KAPPA16")?.state === "DONE", "CLOSED within the board window (24 h) → green DONE, not an alarm");
  const busy = lineStates([ev("AQ2-KAPPA16", "CLOSED", t(30), t(5)), ev("AQ2-KAPPA16", "OPEN", t(2))]).get("AQ2-KAPPA16");
  check(busy?.state === "OPEN" && busy.count === 1, "a new active ANDON on a line with a completed one shows the active state");
  const done2 = stationState(["AQ2-KAPPA16"], lineStates([ev("AQ2-KAPPA16", "CLOSED", t(30), t(20)), ev("AQ2-KAPPA16", "CLOSED", t(10), t(3))]));
  check(done2?.state === "DONE" && done2.count === 2 && done2.lead?.closedAt === t(3), "two completed → green, lead = most recently completed");
  const nui = st.get("AQ1-NUI1");
  check(nui?.state === "OPEN" && nui.count === 3 && nui.lead?.createdAt === t(8), "three active events on one line → OPEN, badge 3, lead = oldest OPEN");
  const order = sortActive(events).map((e) => `${e.lineCode}:${e.status}`);
  check(
    JSON.stringify(order) === JSON.stringify(["AQ2-GAMMA2:OPEN", "AQ1-NUI1:OPEN", "AQ1-NUI1:OPEN", "AP1-MAIN1:ACKNOWLEDGED", "AQ1-NUI1:ACKNOWLEDGED", "RESO-CTR:IN_PROGRESS"]),
    "active list: OPEN before ACK / IN_PROGRESS, then longest elapsed; CLOSED excluded",
  );
  check(elapsedSeconds(events[0], NOW) === 720 && formatElapsed(720) === "12:00", "elapsed 12 min → 12:00");
  check(elapsedSeconds(events[0], NOW + 61_000) === 781 && formatElapsed(781) === "13:01", "elapsed keeps counting (+61 s → 13:01) without new data");
  check(formatElapsed(3 * 3600 + 5) === "3:00:05" && elapsedSeconds(events[3], NOW) === 1800, "hours format; closed event uses its close time");
  check(elapsedSeconds(ev("X", "OPEN", new Date(NOW + 5000).toISOString()), NOW) === 0, "clock skew never gives a negative elapsed time");

  check(categoryKey("QUALITY") === "QUALITY" && categoryKey("MATERIAL") === "MATERIAL" && categoryKey("MAINTENANCE") === "MAINTENANCE" && categoryKey("SAFETY") === "SAFETY" && categoryKey("PRODUCTION") === "OTHER" && categoryKey("OTHER") === "OTHER", "problem-type border: 품질 / 물류 / 설비 / 안전, production and other share one colour");
  check(CATEGORY_LEGEND.length === 5 && new Set(CATEGORY_LEGEND.map((c) => c.key)).size === 5, "legend lists every border colour once");
  check(shiftLabel({ status: "UNRESOLVED" }) === "SHIFT: UNRESOLVED" && shiftLabel(undefined) === "SHIFT: UNRESOLVED" && shiftLabel(null) === "SHIFT: UNRESOLVED", "unresolved / missing shift → 'SHIFT: UNRESOLVED' (no A/B)");
  check(!/\b[AB]\b/.test(shiftLabel({ status: "UNRESOLVED" })) && shiftLabel({ status: "RESOLVED", team: "B", type: "NIGHT" }) === "SHIFT B · NIGHT", "team shown only when resolved");

  const meta = LINES.map((l) => ({ code: l.code, name: l.name, uapAreaCode: l.uapAreaCode ?? null }));
  const shown = displayLines(meta);
  check(shown.length === REAL.length && !shown.some((l) => DEMO.some((d) => d.code === l.code)), "display lines = 36 real lines; demo lines hidden");
  const { stations, unplaced } = placeLines(shown, events);
  const placedN = STATION_CELLS.filter((c) => c.lineCode).length;
  check(stations.filter((s) => s.line).length === placedN && unplaced.length === REAL.length - placedN, `${placedN} lines on stations, ${REAL.length - placedN} in the 'position to confirm' tray`);
  const demoEvent = ev("TGDI1", "OPEN", t(60));
  demoEvent.lineName = "T-GDI 1";
  const withDemo = placeLines(shown, [...events, demoEvent]);
  const strayEvent = ev("XTEST", "IN_PROGRESS", t(50));
  strayEvent.lineName = "Unknown test line";
  check(placeLines(shown, [strayEvent]).unplaced.some((l) => l.code === "XTEST") && !placeLines(shown, [ev("XTEST", "CLOSED", t(60), t(1))]).unplaced.some((l) => l.code === "XTEST"), "a line without a station appears (tray) ONLY while it has an active event — an alarm is never hidden");
  const lock = placeLines(shown, [ev("MUF1", "IN_PROGRESS", t(50))]);
  check(!lock.unplaced.some((l) => l.code === "MUF1") && stationState(["RESO-LOCKSEAM", ...(lock.stations.find((s) => s.cell.id === "NX4JX-LOCKSEAM")!.cell.aliasLineCodes ?? [])], lineStates([ev("MUF1", "IN_PROGRESS", t(50))]))?.state === "ACTION", "plant 2026-10-06: Muffler 1 (no such line) = LOCKSEAM — its event lights the LOCK SEAM station, not the tray");
  check(lineStates([demoEvent]).get("TGDI1")?.state === "OPEN", "old event on a hidden demo line keeps its state (history intact)");
  const kappa = withDemo.stations.find((s) => s.cell.id === "KAPPA-EU7")!;
  const merged = stationState([kappa.line!.code, ...(kappa.cell.aliasLineCodes ?? [])], lineStates([...events, demoEvent, ev("AQ2-TURBO2-EU7", "ACKNOWLEDGED", t(2))]));
  check(merged?.state === "OPEN" && merged.count === 2 && merged.lead?.lineCode === "TGDI1", "alias: an ANDON on T-GDI 1 highlights the KAPPA EU7 station (OPEN beats ACK, count 2)");
  check(!withDemo.unplaced.some((l) => l.code === "TGDI1") && withDemo.unplaced.some((l) => l.code === "MUF1") === false, "alias line is not duplicated in the tray");
}

// ---------------------------------------------------------------- C) HTTP

async function partC() {
  const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  console.log(`C) HTTP ${BASE}`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check(health.backend === "file" && /work[\\/]/.test(health.db), "server under test uses an isolated database under work/");
  const board = await fetch(`${BASE}/api/andons?scope=board`).then((r) => r.json());
  const s = board.shift;
  check(s && (s.status === "UNRESOLVED" ? !("team" in s) && s.reason === "SHIFT_SCHEDULE_NOT_ANCHORED" : ["A", "B"].includes(s.team)), `board shift: ${s?.status}${s?.reason ? " / " + s.reason : ""} (no team when unresolved)`);
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
  };
  walk(board);
  walk(await fetch(`${BASE}/api/meta`).then((r) => r.json()));
  const bad = [...keys].filter((k) => /phone|kakao|email|employee|google|session|token|password|anchor|assignment|supervisor|gapLeader/i.test(k));
  check(bad.length === 0, `public board + meta responses: no personnel / contact / auth / anchor fields (${keys.size} field names)`);
  const all = await fetch(`${BASE}/api/andons?scope=all&limit=500`).then((r) => r.json());
  const demoEvents = all.events.filter((e: AndonEvent) => DEMO.some((d) => d.code === e.lineCode));
  check(demoEvents.length > 0 && demoEvents.every((e: AndonEvent) => e.lineName && e.processName), `historical demo-line events still served with names (${demoEvents.length})`);
  const page = await fetch(`${BASE}/dashboard`);
  check(page.status === 200, "/dashboard renders (200)");
  const list = await fetch(`${BASE}/dashboard/list`);
  check(list.status === 200, "/dashboard/list (previous card view) still available");
}

try {
  partA();
  partB();
  if (process.argv.includes("--http")) await partC();
} catch (err) {
  check(false, `unexpected error: ${(err as Error).stack}`);
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1; // no process.exit(): open fetch sockets + exit() abort Node on Windows
