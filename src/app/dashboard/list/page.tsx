"use client";
import Link from "next/link";
import { fmtDuration, fmtTime, usePolling, useServerNow } from "@/lib/client";
import { useBoardPush } from "@/components/BoardPush";
import { categoryName, departmentLabel, LangToggle, useLang, useT } from "@/lib/i18n";
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
  const lang = useLang();
  const t = useT();

  const counts = data?.counts;
  const events = data?.events ?? [];

  return (
    <main className="dash">
      <header className="dash-head">
        <div className="dash-title">
          <Link href="/" style={{ textDecoration: "none" }}>DIGITAL ANDON</Link>
          <small>FORVIA Yeongcheon · {t("실시간 현황", "Live status")}</small>
        </div>
        <div className="dash-counters">
          <div className="counter counter-RED">
            <div className="n">{counts?.open ?? "-"}</div>
            <div className="l">RED · {t("발생", "Open")}</div>
          </div>
          <div className="counter counter-YELLOW">
            <div className="n">{counts?.inProgress ?? "-"}</div>
            <div className="l">YELLOW · {t("조치중", "In progress")}</div>
          </div>
          <div className="counter counter-GREEN">
            <div className="n">{counts?.closedToday ?? "-"}</div>
            <div className="l">GREEN · {t("금일 완료", "Closed today")}</div>
          </div>
        </div>
        <div className="spacer" />
        <div className="dash-clock" suppressHydrationWarning>{kstClock.format(new Date(now))}</div>
        {stale ? (
          <span className="conn conn-bad" role="alert">
            ⚠ {t("서버 연결 끊김 · 마지막 갱신", "Connection lost · last update")} {lastSuccess ? fmtTime(new Date(lastSuccess).toISOString()) : "-"}
          </span>
        ) : (
          <span className="conn conn-ok">● LIVE</span>
        )}
        <LangToggle />
      </header>

      {data && events.length === 0 && <div className="dash-empty">✔ {t("진행 중인 ANDON 없음 · All clear", "No active ANDON · All clear")}</div>}

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
                  {STATUS_LABEL[e.status][lang]} · {sig}
                </span>
              </div>
              <div className="where">{e.lineName}</div>
              <div className="proc">
                {isPlaceholderProcess(e.processName) ? categoryName(lang, e.categoryCode, e.categoryName) : `${e.processName} · ${categoryName(lang, e.categoryCode, e.categoryName)}`}
              </div>
              <div className="desc">{e.description}</div>
              <div className="meta">
                <div>
                  {t("발생", "Raised")} {fmtTime(e.createdAt)}
                  <br />
                  {t("담당", "Dept.")} {departmentLabel(lang, e.departmentLabel)}
                  {e.acknowledgedBy ? ` · ${e.acknowledgedBy}` : ""}
                </div>
                <div>
                  <div className="elapsed-label">{e.closedAt ? t("소요시간", "Duration") : t("경과시간 Elapsed", "Elapsed")}</div>
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
