// ANDON history as CSV (plant decision 2026-10-08: history is kept 1 year, then deleted — the data can be
// saved locally as CSV, from /history or automatically by the purge script before it deletes).
// One row per event; times in Korea time. Names of the people who acted are included (history), contact
// data never is (it is not stored).
import { db } from "./db.ts";
import { CALL_SITUATIONS } from "./masterData.ts";

const KST = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const kst = (iso: unknown) => (typeof iso === "string" && iso ? KST.format(new Date(iso)) : "");
const q = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_HEADER = ["ANDON ID", "발생", "라인", "공정", "이상 유형", "상황", "조치부서", "상태", "호출", "접수", "접수자", "완료", "완료자", "조치 내용", "소요(분)", "이상 내용"];

/** Events created in [fromIso, toIso) as CSV (UTF-8 with BOM, opens in Excel). */
export async function historyCsv(fromIso: string, toIso: string): Promise<{ csv: string; rows: number }> {
  const events = await db.all(
    `SELECT e.id, e.created_at, l.name AS line, p.name AS process, c.name_ko AS category, e.situations, e.department_code,
            e.status, e.created_by, e.acknowledged_at, e.acknowledged_by, e.closed_at, e.closed_by, e.corrective_action, e.description,
            (SELECT group_concat(COALESCE(d.display_code, d.code), ' · ') FROM andon_event_department x JOIN department d ON d.code = x.department_code WHERE x.event_id = e.id) AS deps
     FROM andon_event e JOIN line l ON l.code = e.line_code JOIN process p ON p.id = e.process_id JOIN category c ON c.code = e.category_code
     WHERE e.created_at >= ? AND e.created_at < ? ORDER BY e.created_at`,
    fromIso,
    toIso,
  );
  const lines = [CSV_HEADER.join(",")];
  for (const e of events) {
    let sits = "";
    try {
      sits = (JSON.parse((e.situations as string) || "[]") as string[]).map((c) => CALL_SITUATIONS.find((s) => s.code === c)?.nameKo ?? c).join(" · ");
    } catch {
      /* none */
    }
    const minutes = e.closed_at ? Math.round((new Date(e.closed_at as string).getTime() - new Date(e.created_at as string).getTime()) / 60_000) : "";
    lines.push(
      [e.id, kst(e.created_at), e.line, e.process, e.category, sits, e.deps || e.department_code, e.status, e.created_by, kst(e.acknowledged_at), e.acknowledged_by, kst(e.closed_at), e.closed_by, e.corrective_action, minutes, e.description]
        .map(q)
        .join(","),
    );
  }
  return { csv: "﻿" + lines.join("\r\n") + "\r\n", rows: events.length };
}
