"use client";
import { useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { StatusBadge } from "@/components/StatusBadge";
import { fmtDateTime, fmtDurationKo, usePolling } from "@/lib/client";
import type { AndonEvent } from "@/lib/domain";

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

function Bars({ rows }: { rows: { name: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0) return <p className="muted">데이터 없음</p>;
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.name}>
          <span>{r.name}</span>
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
  const stats = usePolling<Stats>(`/api/stats?days=${days}`, 10000);
  const list = usePolling<{ events: AndonEvent[] }>("/api/andons?scope=all&limit=200", 10000);
  const s = stats.data;

  return (
    <>
      <TopBar />
      <main className="page page-wide">
        <div className="row">
          <h1 style={{ margin: 0 }}>
            이력 / 통계 <span className="muted" style={{ fontSize: 16 }}>History &amp; Analytics</span>
          </h1>
          <span className="spacer" />
          {[1, 7, 30].map((d) => (
            <button key={d} className={`btn ${days === d ? "btn-primary" : ""}`} onClick={() => setDays(d)}>
              {d === 1 ? "24시간" : `${d}일`}
            </button>
          ))}
        </div>

        {stats.error && <div className="alert alert-error">통계 로드 실패: {stats.error}</div>}

        <div className="stat-grid" style={{ marginTop: 16 }}>
          <div className="stat">
            <div className="label">ANDON 건수</div>
            <div className="value">{s?.total ?? "-"}</div>
          </div>
          <div className="stat">
            <div className="label">미해결 (발생+조치중)</div>
            <div className="value" style={{ color: "var(--red)" }}>
              {s ? s.open + s.inProgress : "-"}
            </div>
          </div>
          <div className="stat">
            <div className="label">평균 응답시간 (발생→접수)</div>
            <div className="value">{fmtDurationKo(s?.avgResponseSec ?? null)}</div>
          </div>
          <div className="stat">
            <div className="label">평균 해결시간 (발생→완료)</div>
            <div className="value">{fmtDurationKo(s?.avgResolutionSec ?? null)}</div>
          </div>
        </div>

        <div className="stat-grid" style={{ marginTop: 10, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>라인별</h2>
            <Bars rows={s?.byLine ?? []} />
          </div>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>유형별</h2>
            <Bars rows={s?.byCategory ?? []} />
          </div>
        </div>

        <h2>반복 이슈 TOP 5 <span className="muted" style={{ fontSize: 14 }}>(같은 라인·공정·유형·내용 2회 이상)</span></h2>
        {s && s.repeatTop5.length === 0 ? (
          <p className="muted">반복 이슈 없음</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>라인 / 공정</th>
                  <th>유형</th>
                  <th>내용</th>
                  <th>횟수</th>
                </tr>
              </thead>
              <tbody>
                {s?.repeatTop5.map((r, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      {r.lineName} / {r.processName}
                    </td>
                    <td>{r.categoryName}</td>
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

        <h2>전체 이력 (최근 200건)</h2>
        {list.error && <div className="alert alert-error">이력 로드 실패: {list.error}</div>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>ANDON ID</th>
                <th>상태</th>
                <th>발생</th>
                <th>라인 / 공정</th>
                <th>유형</th>
                <th>내용</th>
                <th>담당</th>
                <th>응답</th>
                <th>해결</th>
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
                      {e.lineName} / {e.processName}
                    </td>
                    <td>{e.categoryName}</td>
                    <td>{e.description}</td>
                    <td>{e.departmentName}</td>
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
