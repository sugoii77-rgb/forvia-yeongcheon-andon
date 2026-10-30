"use client";
import Link from "next/link";
import { fmtDuration, fmtTime, usePolling, useServerNow } from "@/lib/client";
import { useBoardPush } from "@/components/BoardPush";
import { STATUS_LABEL, isPlaceholderProcess, signalColor, type AndonEvent } from "@/lib/domain";

interface BoardResponse {
  events: AndonEvent[];
  counts: { open: number; inProgress: number; closedToday: number; createdToday: number };
  serverTime: string;
}

// Loads when the server pushes "board changed" (2026-10-29, no more 5-second polling — see ../page.tsx);
// a slow safety load stays. Without push (permission not given yet): every 15 s.
const PUSH_SAFETY_MS = 60_000;
const NO_PUSH_POLL_MS = 15_000;

const kstClock = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export default function DashboardListPage() {
  const push = useBoardPush();
  const pollMs = push.state === "on" ? PUSH_SAFETY_MS : NO_PUSH_POLL_MS;
  const { data, lastSuccess, clockOffsetMs } = usePolling<BoardResponse>("/api/andons?scope=board", pollMs);
  const now = useServerNow(clockOffsetMs);
  // ~2 missed safety loads before the "disconnected" warning
  const stale = lastSuccess == null || now - clockOffsetMs - lastSuccess > 2 * pollMs + 10_000;

  const counts = data?.counts;
  const events = data?.events ?? [];

  return (
    <main className="dash">
      <header className="dash-head">
        <div className="dash-title">
          <Link href="/" style={{ textDecoration: "none" }}>DIGITAL ANDON</Link>
          <small>FORVIA Yeongcheon · 실시간 현황</small>
        </div>
        <div className="dash-counters">
          <div className="counter counter-RED">
            <div className="n">{counts?.open ?? "-"}</div>
            <div className="l">RED · 발생</div>
          </div>
          <div className="counter counter-YELLOW">
            <div className="n">{counts?.inProgress ?? "-"}</div>
            <div className="l">YELLOW · 조치중</div>
          </div>
          <div className="counter counter-GREEN">
            <div className="n">{counts?.closedToday ?? "-"}</div>
            <div className="l">GREEN · 금일 완료</div>
          </div>
        </div>
        <div className="spacer" />
        <div className="dash-clock" suppressHydrationWarning>{kstClock.format(new Date(now))}</div>
        {stale ? (
          <span className="conn conn-bad" role="alert">
            ⚠ 서버 연결 끊김 · 마지막 갱신 {lastSuccess ? fmtTime(new Date(lastSuccess).toISOString()) : "-"}
          </span>
        ) : (
          <span className="conn conn-ok">● LIVE</span>
        )}
      </header>

      {data && events.length === 0 && <div className="dash-empty">✔ 진행 중인 ANDON 없음 · All clear</div>}

      <section className="dash-grid">
        {events.map((e) => {
          const sig = signalColor(e.status);
          const end = e.closedAt ? new Date(e.closedAt).getTime() : now;
          const elapsed = (end - new Date(e.createdAt).getTime()) / 1000;
          return (
            <Link key={e.id} href={`/respond/${encodeURIComponent(e.id)}`} className={`dash-card sig-${sig}`}>
              <div className="top">
                <span className="id">{e.id}</span>
                <span className="status">
                  {STATUS_LABEL[e.status].ko} · {sig}
                </span>
              </div>
              <div className="where">{e.lineName}</div>
              <div className="proc">
                {isPlaceholderProcess(e.processName) ? e.categoryName : `${e.processName} · ${e.categoryName}`}
              </div>
              <div className="desc">{e.description}</div>
              <div className="meta">
                <div>
                  발생 {fmtTime(e.createdAt)}
                  <br />
                  담당 {e.departmentLabel}
                  {e.acknowledgedBy ? ` · ${e.acknowledgedBy}` : ""}
                </div>
                <div>
                  <div className="elapsed-label">{e.closedAt ? "소요시간" : "경과시간 Elapsed"}</div>
                  <div className="elapsed">{fmtDuration(elapsed)}</div>
                </div>
              </div>
            </Link>
          );
        })}
      </section>
    </main>
  );
}
