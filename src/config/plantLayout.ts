// Yeongcheon plant map for the shop-floor ANDON display (version-controlled; maintained by UAP / IT).
//
// Source: "layout.pptx" PAGE 2 "PLANT LAYOUT" (FCM Yeongcheon plant presentation, Jan 2026). Positions
// are the colored station cells of that page, transformed into a 100 × 100 map frame:
//   x: slide 18 %..97 %  → map 7..100 (left band 0..7 = warehouses)
//   y: piecewise, production rows get more height than warehouses / aisles:
//      slide 17–29 → 0–8 (finished goods band) · row 1 29.1–40.8 → 8–38 · aisle → 38–43 ·
//      row 2 43.8–56.9 → 43–71 · aisle → 71–74 · row 3 60.5–77.4 → 74–93 · 77.4–87 → 93–100
// The arrangement (left/right, row, neighbors) follows the drawing; sizes are approximate.
//
// The DATABASE is the source of truth for line identity and status. A station is linked to a line
// ONLY when the match is certain (lineCode). Uncertain matches carry candidateLineCode and are NOT
// placed: those lines appear in the "position to be confirmed" tray until UAP confirms — then move
// the code from candidateLineCode to lineCode (and set match). Page 1 evacuation content is not used.

export type MapTone = "AQ" | "AP" | "SUB";
export type RowSlot = "full" | "top" | "bottom";

/** Vertical bands of the three production rows (map units). */
export const MAP_ROWS: Record<1 | 2 | 3, { y: number; h: number }> = {
  1: { y: 8.4, h: 29.2 },
  2: { y: 43.4, h: 27.2 },
  3: { y: 74.4, h: 18.2 },
};

export interface StationCell {
  /** Stable id of the physical station (layout label based). */
  id: string;
  /** Text as written on page 2. */
  layoutLabel: string;
  row: 1 | 2 | 3;
  slot: RowSlot;
  /** Left edge and width in map units (0..100). */
  x: number;
  w: number;
  /** Zone colour on page 2: AQ (accent4), AP (accent2), SUB (yellow sub-assembly / RESO rows). */
  tone: MapTone;
  /** Confirmed DB line (line.code). */
  lineCode?: string;
  /** How the confirmed link was established. */
  match?: "EXACT_NAME" | "PAGE1_NAME" | "PLANT_DECISION";
  /** Possible DB line — NOT used for display until confirmed. */
  candidateLineCode?: string;
  note?: string;
  /** Plant-confirmed description of what the station produces (shown small under the line name). */
  subLabel?: string;
}

// prettier-ignore
export const STATION_CELLS: StationCell[] = [
  // ---- row 1 (north) — AQ ASSEMBLY, left to right ------------------------------- slide x / y (%)
  { id: "NUI1", layoutLabel: "NU-I #1", row: 1, slot: "top", x: 18.5, w: 6.3, tone: "AQ", lineCode: "AQ1-NUI1", match: "EXACT_NAME" }, // 27.5–33.5 / 29.1–40.7
  { id: "NUI2", layoutLabel: "NU-I #2", row: 1, slot: "bottom", x: 18.5, w: 6.3, tone: "AQ", lineCode: "AQ1-NUI2", match: "EXACT_NAME" },
  { id: "NUI2-EXMANI", layoutLabel: "NU-I #2 EXMANI", row: 1, slot: "full", x: 25.6, w: 5.7, tone: "AQ", lineCode: "AQ1-NUI2-EXMANI", match: "EXACT_NAME" }, // 33.5–38.9
  { id: "GAMMA3", layoutLabel: "GAMMA#3", row: 1, slot: "full", x: 31.9, w: 5.3, tone: "AQ", lineCode: "AQ3-GAMMA3", match: "EXACT_NAME" }, // 38.9–44.0
  { id: "KAPPA-UCC", layoutLabel: "KAPPA UCC", row: 1, slot: "top", x: 37.9, w: 5.3, tone: "AQ", lineCode: "AQ3-KAPPA-UCC", match: "EXACT_NAME" }, // 44.0–49.1
  { id: "GAMMA2", layoutLabel: "GAMMA #2", row: 1, slot: "bottom", x: 37.9, w: 5.3, tone: "AQ", lineCode: "AQ2-GAMMA2", match: "EXACT_NAME", note: "label straddles the GAMMA#3 / KAPPA UCC cells" },
  { id: "UCC", layoutLabel: "UCC", row: 1, slot: "full", x: 44.0, w: 4.7, tone: "AQ", lineCode: "AQ3-UCC", match: "EXACT_NAME" }, // 49.1–53.7
  { id: "R-DPF", layoutLabel: "R-DPF", row: 1, slot: "full", x: 49.9, w: 4.3, tone: "AQ", note: "no DB line named R-DPF; DB AQ-3 has R-ENG (different name) — not linked" }, // 54.1–58.4
  // ---- row 1 — AP ASSEMBLY
  { id: "JX-ASSY1", layoutLabel: "JX ASSY #1", row: 1, slot: "full", x: 57.5, w: 6.3, tone: "AP", candidateLineCode: "AP2-JX-ASSY", note: "DB 'JX ASSY' vs layout 'JX ASSY #1'" }, // 60.6–66.5
  { id: "NX4-2", layoutLabel: "NX4 #2", row: 1, slot: "full", x: 64.7, w: 7.2, tone: "AP", candidateLineCode: "AP1-NX4-CTR2", note: "DB 'NX4 CTR #2' vs layout 'NX4 #2'" }, // 66.7–73.4
  { id: "MAIN2", layoutLabel: "MAIN #2", row: 1, slot: "top", x: 72.5, w: 7.0, tone: "AP", lineCode: "AP1-MAIN2", match: "EXACT_NAME" }, // 73.4–79.9
  { id: "MAIN1", layoutLabel: "MAIN #1", row: 1, slot: "bottom", x: 72.5, w: 7.0, tone: "AP", lineCode: "AP1-MAIN1", match: "EXACT_NAME" },
  { id: "NX4-CTR", layoutLabel: "NX4 CTR", row: 1, slot: "full", x: 80.2, w: 8.0, tone: "AP", lineCode: "AP1-NX4-CTR", match: "EXACT_NAME" }, // 79.9–87.3

  // ---- row 2 (middle) — AQ ASSEMBLY ---------------------------------------------------- y 43.8–56.9
  { id: "NUI1-EXMANI", layoutLabel: "NU-I #1 EXMANI", row: 2, slot: "full", x: 14.1, w: 7.1, tone: "AQ", lineCode: "AQ1-NUI1-EXMANI", match: "EXACT_NAME" }, // 23.7–30.3
  { id: "GPF", layoutLabel: "GPF", row: 2, slot: "full", x: 21.8, w: 6.1, tone: "AQ", lineCode: "AQ1-GPF", match: "EXACT_NAME", subLabel: "EURO7 GPF · GAMMA T‑GDI 3차", note: "plant 2026-10-02: one line for EURO7 GPF and GAMMA T-GDI 3차 (mixed production)" }, // 30.3–36.1
  { id: "EXMANI1", layoutLabel: "EXMANI #1", row: 2, slot: "top", x: 28.6, w: 5.9, tone: "AQ", lineCode: "AQ2-EXMANI1", match: "EXACT_NAME" }, // 36.1–41.6
  { id: "EXMANI2", layoutLabel: "EXMANI #2", row: 2, slot: "bottom", x: 28.6, w: 5.9, tone: "AQ", lineCode: "AQ2-EXMANI2", match: "EXACT_NAME" },
  { id: "LAMBDA-FRT", layoutLabel: "LAMBDA FRT", row: 2, slot: "full", x: 35.2, w: 6.4, tone: "AP", candidateLineCode: "AP2-JX-LAMBDA-FRT", note: "DB 'JX LAMBDA FRT' vs layout 'LAMBDA FRT' (AP-coloured cell inside the AQ area)" }, // 41.6–47.6
  { id: "GAMMA2-TGDI", layoutLabel: "GAMMA2 T-GDI", row: 2, slot: "full", x: 42.3, w: 5.1, tone: "AQ", lineCode: "AQ2-TURBO1", match: "PLANT_DECISION", subLabel: "GAMMA T‑GDI 2차", note: "plant decision 2026-10-02: the GAMMA2 T-GDI station is the AQ-2 line 'TURBO#1' (dedicated GAMMA T-GDI 2차 line)" }, // 47.6–52.6
  { id: "KAPPA-EU7", layoutLabel: "KAPPA EU7", row: 2, slot: "top", x: 48.6, w: 5.0, tone: "AQ", lineCode: "AQ2-TURBO2-EU7", match: "PLANT_DECISION", subLabel: "KAPPA EURO7 · GAMMA T‑GDI 1차", note: "plant decision 2026-10-02: the KAPPA EU7 station is the AQ-2 line 'TURBO #2 EU7' (KAPPA EURO7 mixed with GAMMA T-GDI 1차)" }, // 53.0–57.9
  { id: "KAPPA16", layoutLabel: "KAPPA 1.6", row: 2, slot: "bottom", x: 48.6, w: 5.0, tone: "AQ", lineCode: "AQ2-KAPPA16", match: "EXACT_NAME" },
  // ---- row 2 — AP ASSEMBLY
  { id: "NX4JX-MAIN-RESO", layoutLabel: "NX4/JX MAIN RESO", row: 2, slot: "full", x: 58.1, w: 7.1, tone: "SUB", candidateLineCode: "RESO-JX-NX4", note: "DB 'JX/NX4 RESO' vs layout 'NX4/JX MAIN RESO'" }, // 61.1–67.7
  { id: "JX-SUB", layoutLabel: "JX SUB", row: 2, slot: "top", x: 66.1, w: 8.1, tone: "AP", lineCode: "AP2-JX-SUB", match: "EXACT_NAME" }, // 67.9–75.4
  { id: "MAIN3", layoutLabel: "MAIN #3", row: 2, slot: "bottom", x: 66.1, w: 8.1, tone: "AP", lineCode: "AP2-MAIN3", match: "EXACT_NAME" },
  { id: "CTR2", layoutLabel: "CTR #2", row: 2, slot: "top", x: 74.9, w: 7.8, tone: "AP", lineCode: "AP2-CTR2", match: "EXACT_NAME" }, // 75.4–82.7
  { id: "CTR1", layoutLabel: "CTR #1", row: 2, slot: "bottom", x: 74.9, w: 7.8, tone: "AP", lineCode: "AP2-CTR1", match: "EXACT_NAME" },
  { id: "NX4-MAIN", layoutLabel: "NX4 MAIN", row: 2, slot: "top", x: 83.5, w: 9.1, tone: "AP", lineCode: "AP1-NX4-MAIN", match: "EXACT_NAME" }, // 82.7–91.0
  { id: "FRT", layoutLabel: "FRT", row: 2, slot: "bottom", x: 83.5, w: 9.1, tone: "AP", lineCode: "AP1-FRT", match: "EXACT_NAME" },

  // ---- row 3 (south) — forming / bending / stuffing ------------------------------------- y 60.5–77.4
  { id: "FORMING-CUTTING", layoutLabel: "FORMING & CUTTING", row: 3, slot: "top", x: 8.7, w: 29.6, tone: "SUB", candidateLineCode: "BND-PIPE-CUTTING", note: "DB 'PIPE CUTTING' vs layout 'FORMING & CUTTING'" }, // 19.2–44.9
  { id: "AQ-BENDING", layoutLabel: "AQ BENDING", row: 3, slot: "bottom", x: 8.7, w: 13.2, tone: "SUB", lineCode: "BND-HE-BENDING", match: "PAGE1_NAME", note: "page 1 names this exact cell 'HE BENDING'" }, // 18.1–31.0
  { id: "AP-BENDING", layoutLabel: "AP BENDING", row: 3, slot: "bottom", x: 22.7, w: 15.6, tone: "SUB", lineCode: "BND-CE-BENDING", match: "PAGE1_NAME", note: "page 1 names this exact cell 'CE BENDING'" }, // 31.0–43.9
  { id: "AUTO-STUFFING2", layoutLabel: "AUTO STUFFING #2", row: 3, slot: "top", x: 39.1, w: 13.9, tone: "SUB", note: "DB has one line 'STUFFING' (AQ-3); layout shows #1 and #2 — not linked" }, // 45.0–57.4
  { id: "AUTO-STUFFING1", layoutLabel: "AUTO STUFFING #1", row: 3, slot: "bottom", x: 39.1, w: 13.9, tone: "SUB", note: "see AUTO STUFFING #2" },
  // ---- row 3 — RESO
  { id: "NX4JX-LOCKSEAM", layoutLabel: "NX4/JX LOCK SEAM", row: 3, slot: "full", x: 58.5, w: 8.6, tone: "SUB", candidateLineCode: "RESO-LOCKSEAM", note: "DB 'LOCKSEAM' vs layout 'NX4/JX LOCK SEAM'" }, // 61.5–69.3
  { id: "QX-MAIN-RESO", layoutLabel: "QX MAIN RESO", row: 3, slot: "full", x: 68.1, w: 9.2, tone: "SUB", candidateLineCode: "RESO-QX", note: "DB 'QX RESO' vs layout 'QX MAIN RESO'" }, // 69.6–78.0
  { id: "SX2-MAIN-RESO", layoutLabel: "SX2 MAIN RESO", row: 3, slot: "full", x: 78.0, w: 8.8, tone: "SUB", candidateLineCode: "RESO-SX2", note: "DB 'SX2 RESO' vs layout 'SX2 MAIN RESO'" }, // 78.0–86.1
  { id: "CTR-RESO", layoutLabel: "CTR RESO", row: 3, slot: "full", x: 87.5, w: 10.6, tone: "SUB", lineCode: "RESO-CTR", match: "EXACT_NAME" }, // 86.1–95.7
];

/** Zone backgrounds and titles as on page 2 (titles only where the drawing has them). */
export const MAP_ZONES: { id: string; title: string | null; tone: MapTone; x: number; y: number; w: number; h: number; titleY?: number }[] = [
  { id: "AQ", title: "AQ ASSEMBLY", tone: "AQ", x: 13.6, y: 7.9, w: 41.0, h: 63.6, titleY: 38.4 },
  { id: "AP", title: "AP ASSEMBLY", tone: "AP", x: 57.1, y: 7.9, w: 36.0, h: 63.6, titleY: 38.4 },
  { id: "SUB-W", title: null, tone: "SUB", x: 8.2, y: 73.9, w: 45.4, h: 19.2 },
  { id: "SUB-E", title: null, tone: "SUB", x: 58.0, y: 73.9, w: 40.6, h: 19.2 },
];

/** Orientation landmarks only — never ANDON entities. */
export const MAP_LANDMARKS: { id: string; label: string; x: number; y: number; w: number; h: number; vertical?: boolean }[] = [
  { id: "FG-WH", label: "FINISHED GOODS WAREHOUSE", x: 37.0, y: 1.6, w: 26.6, h: 5.4 },
  { id: "BOP-WH", label: "BOP WAREHOUSE", x: 0.6, y: 8.4, w: 12.4, h: 62.6, vertical: true },
  { id: "CATALYST-WH", label: "CATALYST WAREHOUSE", x: 0.6, y: 74.4, w: 7.2, h: 18.2, vertical: true },
  { id: "QC-LAB", label: "QC LAB", x: 0.6, y: 94.4, w: 10.0, h: 5.0 },
  { id: "MAINTENANCE", label: "MAINTENANCE", x: 78.1, y: 94.4, w: 13.9, h: 5.0 },
];

/** Box of a station in map units. */
export function stationBox(c: StationCell, gap = 0.6): { x: number; y: number; w: number; h: number } {
  const r = MAP_ROWS[c.row];
  if (c.slot === "full") return { x: c.x, y: r.y, w: c.w, h: r.h };
  const half = (r.h - gap) / 2;
  return { x: c.x, y: c.slot === "top" ? r.y : r.y + half + gap, w: c.w, h: half };
}

/**
 * Real lines WITHOUT a confirmed station — explicitly listed (test:display checks that every real line
 * is either on a station or here). They are shown in the "position to confirm" tray, never hidden.
 */
export const UNMAPPED_LINES: Record<string, { candidateStation: string | null; reason: string }> = {
  "AP1-NX4-CTR2": { candidateStation: "NX4-2", reason: "layout says 'NX4 #2'" },
  "AP2-JX-ASSY": { candidateStation: "JX-ASSY1", reason: "layout says 'JX ASSY #1'" },
  "AP2-JX-LAMBDA-FRT": { candidateStation: "LAMBDA-FRT", reason: "layout says 'LAMBDA FRT'" },
  "AQ3-R-ENG": { candidateStation: null, reason: "layout has 'R-DPF', not 'R-ENG'" },
  "AQ3-STUFFING": { candidateStation: null, reason: "layout has AUTO STUFFING #1 and #2; DB has one 'STUFFING'" },
  "BND-PIPE-CUTTING": { candidateStation: "FORMING-CUTTING", reason: "layout says 'FORMING & CUTTING'" },
  "RESO-LOCKSEAM": { candidateStation: "NX4JX-LOCKSEAM", reason: "layout says 'NX4/JX LOCK SEAM'" },
  "RESO-QX": { candidateStation: "QX-MAIN-RESO", reason: "layout says 'QX MAIN RESO'" },
  "RESO-SX2": { candidateStation: "SX2-MAIN-RESO", reason: "layout says 'SX2 MAIN RESO'" },
  "RESO-JX-NX4": { candidateStation: "NX4JX-MAIN-RESO", reason: "layout says 'NX4/JX MAIN RESO'" },
};
