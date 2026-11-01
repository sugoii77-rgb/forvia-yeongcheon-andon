"use client";
// /history → "CSV 저장": the ANDON history of a period as a CSV file on this PC (history is kept 1 year).
import { useState } from "react";
import { useMe } from "@/lib/client";
import { useT } from "@/lib/i18n";

const kstDay = (offsetDays = 0) => new Date(Date.now() + 9 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

export function HistoryCsv() {
  const { user } = useMe();
  const [from, setFrom] = useState(() => kstDay(-30));
  const [to, setTo] = useState(() => kstDay(0));
  const t = useT();
  if (!user?.active) return null;
  const ok = !!from && !!to && from <= to;
  return (
    <div className="card csv-card" data-testid="history-csv">
      <strong>{t("CSV 저장", "Save as CSV")}</strong>
      <span className="muted" style={{ fontSize: 14 }}>{t("이력은 1년간 보관 후 삭제됩니다. 필요한 기간은 PC에 저장해 두세요.", "History is kept for 1 year. Save the periods you need on your PC.")}</span>
      <div className="row" style={{ alignItems: "center" }}>
        <label htmlFor="csv-from" className="muted">{t("기간", "Period")}</label>
        <input id="csv-from" className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={{ width: "auto" }} />
        <span>~</span>
        <input id="csv-to" className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={{ width: "auto" }} />
        <a
          className={`btn btn-primary${ok ? "" : " disabled"}`}
          aria-disabled={!ok}
          href={ok ? `/api/history/export?from=${from}&to=${to}` : undefined}
          download
        >
          {t("CSV 저장", "Save CSV")}
        </a>
      </div>
    </div>
  );
}
