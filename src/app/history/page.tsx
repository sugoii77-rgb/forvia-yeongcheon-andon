"use client";
import { useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { StatusBadge } from "@/components/StatusBadge";
import { fmtDateTime, fmtDurationKo, usePolling } from "@/lib/client";
import { HistoryCsv } from "@/components/HistoryCsv";
import { lineWithProcess, type AndonEvent } from "@/lib/domain";
import { categoryName, categoryNameByKo, departmentLabel, useLang, useT } from "@/lib/i18n";

interface Stats {
  total: number;
  open: number;
  inProgress: number;
  closed: number;
  avgResponseSec: number | null;
  avgResolutionSec: number | null;
  byLine: { name: string; count: number }[];
  byCategory: { name: string; count: number }[];
  repeatTop5: { lineName: string; processName: string; categoryName: string; description: string; count: number }[];
}

function Bars({ rows, label = (n) => n }: { rows: { name: string; count: number }[]; label?: (name: string) => string }) {
  const t = useT();
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0) return <p className="muted">{t("데이터 없음", "No data")}</p>;
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.name}>
          <span>{label(r.name)}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(r.count / max) * 100}%` }} />
          </div>
          <strong style={{ textAlign: "right" }}>{r.count}</strong>
        </div>
      ))}
    </div>
  );
}

export default function HistoryPage() {
  const [days, setDays] = useState(7);
  const stats = usePolling<Stats>(`/api/stats?days=${days}`, 60000);
  const list = usePolling<{ events: AndonEvent[] }>("/api/andons?scope=all&limit=200", 60000);
  const s = stats.data;
  const lang = useLang();
  const t = useT();

  return (
    <>
      <TopBar />
      <main className="page page-wide">
        <div className="row">
          <h1 style={{ margin: 0 }}>
            {t("이력 / 통계", "History & analytics")}
          </h1>
          <span className="spacer" />
          {[1, 7, 30].map((d) => (
            <button key={d} className={`btn ${days === d ? "btn-primary" : ""}`} onClick={() => setDays(d)}>
              {d === 1 ? t("24시간", "24 h") : t(`${d}일`, `${d} days`)}
            </button>
          ))}
        </div>

        <HistoryCsv />

        {stats.error && <div className="alert alert-error">{t("통계 로드 실패", "Could not load statistics")}: {stats.error}</div>}

        <div className="stat-grid" style={{ marginTop: 16 }}>
          <div className="stat">
            <div className="label">{t("ANDON 건수", "ANDON calls")}</div>
            <div className="value">{s?.total ?? "-"}</div>
          </div>
          <div className="stat">
            <div className="label">{t("미해결 (발생+조치중)", "Open (raised + in progress)")}</div>
            <div className="value" style={{ color: "var(--red)" }}>
              {s ? s.open + s.inProgress : "-"}
            </div>
          </div>
          <div className="stat">
            <div className="label">{t("평균 응답시간 (발생→접수)", "Avg. response time (raised → ACK)")}</div>
            <div className="value">{fmtDurationKo(s?.avgResponseSec ?? null)}</div>
          </div>
          <div className="stat">
            <div className="label">{t("평균 해결시간 (발생→완료)", "Avg. resolution time (raised → closed)")}</div>
            <div className="value">{fmtDurationKo(s?.avgResolutionSec ?? null)}</div>
          </div>
        </div>

        <div className="stat-grid" style={{ marginTop: 10, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>{t("라인별", "By line")}</h2>
            <Bars rows={s?.byLine ?? []} />
          </div>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>{t("유형별", "By problem type")}</h2>
            <Bars rows={s?.byCategory ?? []} label={(n) => categoryNameByKo(lang, n)} />
          </div>
        </div>

        <h2>{t("반복 이슈 TOP 5", "Repeated issues TOP 5")} <span className="muted" style={{ fontSize: 14 }}>{t("(같은 라인·공정·유형·내용 2회 이상)", "(same line · process · type · text, 2× or more)")}</span></h2>
        {s && s.repeatTop5.length === 0 ? (
          <p className="muted">{t("반복 이슈 없음", "No repeated issues")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t("라인 / 공정", "Line / process")}</th>
                  <th>{t("유형", "Type")}</th>
                  <th>{t("내용", "Description")}</th>
                  <th>{t("횟수", "Count")}</th>
                </tr>
              </thead>
              <tbody>
                {s?.repeatTop5.map((r, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      {lineWithProcess(r.lineName, r.processName)}
                    </td>
                    <td>{categoryNameByKo(lang, r.categoryName)}</td>
                    <td>{r.description}</td>
                    <td>
                      <strong>{r.count}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h2>{t("전체 이력 (최근 200건)", "All ANDON (latest 200)")}</h2>
        {list.error && <div className="alert alert-error">{t("이력 로드 실패", "Could not load the history")}: {list.error}</div>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>ANDON ID</th>
                <th>{t("상태", "Status")}</th>
                <th>{t("발생", "Raised")}</th>
                <th>{t("라인 / 공정", "Line / process")}</th>
                <th>{t("유형", "Type")}</th>
                <th>{t("내용", "Description")}</th>
                <th>{t("담당", "Dept.")}</th>
                <th>{t("응답", "Response")}</th>
                <th>{t("해결", "Resolution")}</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.events.map((e) => {
                const t0 = new Date(e.createdAt).getTime();
                const resp = e.acknowledgedAt ? (new Date(e.acknowledgedAt).getTime() - t0) / 1000 : null;
                const reso = e.closedAt ? (new Date(e.closedAt).getTime() - t0) / 1000 : null;
                return (
                  <tr key={e.id}>
                    <td>
                      <Link href={`/respond/${encodeURIComponent(e.id)}`}>{e.id}</Link>
                    </td>
                    <td>
                      <StatusBadge status={e.status} />
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(e.createdAt)}</td>
                    <td>
                      {lineWithProcess(e.lineName, e.processName)}
                    </td>
                    <td>{categoryName(lang, e.categoryCode, e.categoryName)}</td>
                    <td>{e.description}</td>
                    <td>{departmentLabel(lang, e.departmentLabel)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDurationKo(resp)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDurationKo(reso)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
