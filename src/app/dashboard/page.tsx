"use client";
// Shop-floor display v2 — PLANT MAP ANDON. Answers one question from several meters away:
// "WHERE is the abnormal condition right now?" Lines keep their physical position (plant layout page 2,
// src/config/plantLayout.ts); an abnormal line lights up in place, it never moves. Public display:
// line, problem category, state, elapsed time and — since 2026-10-08 (plant request) — the NAME of the
// person who acknowledged / completed it. Never contact data.
import Link from "next/link";
import type { CSSProperties } from "react";
import { fmtTime, usePolling, useServerNow } from "@/lib/client";
import { useBoardPush } from "@/components/BoardPush";
import { MAP_FRAME, MAP_ZONES } from "@/config/plantLayout";
import { STATUS_LABEL, type AndonEvent, type MasterData } from "@/lib/domain";
import { CATEGORY_LEGEND, categoryKey, displayLines, stationState, elapsedSeconds, formatElapsed, lineStates, placeLines, shiftLabel, sortActive, sortDone, type LineState, type MapLine } from "@/lib/plantMap";

type PublicShift = { status: "RESOLVED"; team: "A" | "B"; type: "DAY" | "NIGHT"; operationalDate: string; shiftEnd: string } | { status: "UNRESOLVED"; reason: string };
interface BoardResponse {
  events: AndonEvent[];
  counts: { open: number; inProgress: number; closedToday: number; createdToday: number };
  serverTime: string;
  shift?: PublicShift;
}

// No more 5-second polling (2026-10-29, Vercel free-tier CPU): the board loads when the server pushes "board
// changed" (ANDON raised / acknowledged / in action / completed — useBoardPush). A slow safety load stays in
// case a push is lost (it also keeps the shift label and the 2-hour escalation check going). A display without
// push (permission not given yet) loads every 15 s.
const PUSH_SAFETY_MS = 60_000;
const NO_PUSH_POLL_MS = 15_000;
// Green ceremony (plant 2026-10-16): a line that has just been completed celebrates — CELEBRATE_MS after the
// close, plus the time the update needs to arrive (a push: seconds; without push: up to one load interval).
const CELEBRATE_MS = 5000;
const PUSH_DELAY_MS = 5000;
const CONFETTI = Array.from({ length: 14 }, (_, i) => i);
const META_MS = 5 * 60_000;

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

// The big screen shows only the production building (plant 2026-10-16): warehouses / QC lab / maintenance are
// left out and the building outline (MAP_FRAME) is stretched to the whole map area — tiles and text grow with it.
const F = MAP_FRAME;
const fit = (b: { x: number; y: number; w: number; h: number }) => ({ x: ((b.x - F.x) / F.w) * 100, y: ((b.y - F.y) / F.h) * 100, w: (b.w / F.w) * 100, h: (b.h / F.h) * 100 });
const pct = (raw: { x: number; y: number; w: number; h: number }) => {
  const b = fit(raw);
  return { left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` };
};
const stateText = (s: LineState) =>
  s.state === "OPEN"
    ? "발생 OPEN"
    : `${STATUS_LABEL[s.lead!.status].ko}${s.lead!.acknowledgedBy ? ` · ${s.lead!.acknowledgedBy}` : ` ${s.lead!.status === "ACKNOWLEDGED" ? "ACK" : "IN ACTION"}`}`;

function LineTile({ line, st, now, celebrateMs, compact, sub, tone }: { line: MapLine; st: LineState | undefined; now: number; celebrateMs: number; compact?: boolean; sub?: string; tone?: string }) {
  if (!st) {
    return (
      <div className={`pm-line pm-normal${tone ? ` pm-tone-${tone}` : ""}${compact ? " pm-chip" : ""}`} data-line={line.code} data-state="NORMAL" title={sub}>
        <span className="pm-name">{line.name}</span>
        {sub && <span className="pm-sub">{sub}</span>}
      </div>
    );
  }
  const e = st.lead!;
  if (st.state === "DONE") {
    // completed within 24 h: green, compact — name + completion time; just completed: a short ceremony
    const celebrate = now - Date.parse(e.closedAt!) < celebrateMs;
    return (
      <Link href={`/respond/${encodeURIComponent(e.id)}`} className={`pm-line pm-done${celebrate ? " pm-celebrate" : ""}${compact ? " pm-chip" : ""}`} data-line={line.code} data-state="DONE" title={`${line.name} · 완료 ${fmtTime(e.closedAt!)}`}>
        {celebrate && (
          <span className="pm-cele-burst" aria-hidden>
            {CONFETTI.map((i) => (
              <i key={i} style={{ "--a": `${i * (360 / CONFETTI.length)}deg`, "--d": `${(i % 3) * 0.18}s` } as CSSProperties} />
            ))}
          </span>
        )}
        <span className="pm-name">{line.name}</span>
        <span className="pm-state">✔ 완료 {fmtTime(e.closedAt!)}{e.closedBy ? ` · ${e.closedBy}` : ""}</span>
      </Link>
    );
  }
  return (
    <Link
      href={`/respond/${encodeURIComponent(e.id)}`}
      className={`pm-line pm-${st.state === "OPEN" ? "open" : "action"} pm-c-${categoryKey(e.categoryCode)}${compact ? " pm-chip" : ""}`}
      data-line={line.code}
      data-state={st.state}
      data-category={categoryKey(e.categoryCode)}
      title={`${line.name}${sub ? ` (${sub})` : ""} · ${e.categoryName} · ${e.description}`}
    >
      <span className="pm-top">
        <span className="pm-name">{line.name}</span>
        {st.count > 1 && <span className="pm-badge" aria-label={`${st.count} active ANDON`}>{st.count}</span>}
      </span>
      {!compact && <span className="pm-cat">{e.categoryName}{e.lineCode !== line.code ? ` · ${e.lineName}` : ""}</span>}
      {!compact && <span className="pm-desc">{e.description}</span>}
      <span className="pm-time">{formatElapsed(elapsedSeconds(e, now))}</span>
      {!compact && <span className="pm-state">{stateText(st)}</span>}
    </Link>
  );
}

export default function PlantMapPage() {
  const push = useBoardPush();
  const pollMs = push.state === "on" ? PUSH_SAFETY_MS : NO_PUSH_POLL_MS;
  const { data, lastSuccess, clockOffsetMs } = usePolling<BoardResponse>("/api/andons?scope=board", pollMs);
  const { data: meta } = usePolling<MasterData>("/api/meta", META_MS);
  const now = useServerNow(clockOffsetMs);
  // ~2 missed safety loads before the "disconnected" warning
  const stale = lastSuccess == null || now - clockOffsetMs - lastSuccess > 2 * pollMs + 10_000;
  const celebrateMs = CELEBRATE_MS + (push.state === "on" ? PUSH_DELAY_MS : pollMs);

  const events = data?.events ?? [];
  const states = lineStates(events);
  const realLines = displayLines(meta?.lines ?? []);
  const { stations, unplaced } = placeLines(realLines, events);
  const active = sortActive(events);
  // tray: abnormal lines first so they are never pushed out of view
  const rank = (code: string) => { const st = states.get(code)?.state; return st === "OPEN" ? 0 : st === "ACTION" ? 1 : 2; };
  const unplacedSorted = [...unplaced].sort((a, b) => rank(a.code) - rank(b.code));
  // one entry per shown line: a station (its line + alias lines) or a tray line
  const shownStates = [
    ...stations.filter((s) => s.line).map((s) => stationState([s.line!.code, ...(s.cell.aliasLineCodes ?? [])], states)),
    ...unplaced.map((l) => states.get(l.code)),
  ];
  const openLines = shownStates.filter((x) => x?.state === "OPEN").length;
  const actionLines = shownStates.filter((x) => x?.state === "ACTION").length;
  const normalLines = shownStates.filter((x) => !x || x.state === "DONE").length;
  const doneEvents = sortDone(events);

  return (
    <main className="floor">
      <header className="floor-head">
        <Link href="/" className="floor-title">
          DIGITAL ANDON <small>· YEONGCHEON</small>
        </Link>
        <span className="fc fc-open" data-testid="count-open">● OPEN {meta ? openLines : "-"}</span>
        <span className="fc fc-action" data-testid="count-action">● IN ACTION {meta ? actionLines : "-"}</span>
        <span className="fc fc-normal" data-testid="count-normal">● NORMAL {meta ? normalLines : "-"}</span>
        <span className="fc fc-done" data-testid="count-done">✔ 완료 24h {data ? doneEvents.length : "-"}</span>
        <span className="spacer" />
        <span className={`fc fc-shift${data?.shift?.status === "RESOLVED" ? "" : " fc-unresolved"}`} data-testid="shift">
          {data ? shiftLabel(data.shift) : "SHIFT: -"}
        </span>
        <span className="floor-clock" suppressHydrationWarning>{kstClock.format(new Date(now))}</span>
        {stale ? (
          <span className="conn conn-bad" role="alert">
            ⚠ 서버 연결 끊김 · 마지막 갱신 {lastSuccess ? fmtTime(new Date(lastSuccess).toISOString()) : "-"}
          </span>
        ) : (
          <span className="conn conn-ok" title={push.state === "on" ? "ANDON이 바뀌면 즉시 갱신 (푸시)" : `${NO_PUSH_POLL_MS / 1000}초마다 갱신`}>
            <i className="live-dot" aria-hidden /> LIVE
          </span>
        )}
        {push.state === "off" && (
          <button type="button" className="conn conn-push" onClick={() => push.enable()} data-testid="board-push-enable">
            실시간 갱신 켜기 ({NO_PUSH_POLL_MS / 1000}초 갱신 중)
          </button>
        )}
        {push.state === "blocked" && (
          <span className="conn conn-push" title="브라우저 주소창 왼쪽 자물쇠 → 알림 → 허용">알림 차단됨 · {NO_PUSH_POLL_MS / 1000}초 갱신</span>
        )}
      </header>

      <div className="floor-body">
        <section className="pm-wrap" aria-label="Plant map">
          <div className={`pm${active.length > 0 ? " pm-has-alarm" : ""}`} style={{ "--pmu": `${100 / F.w}cqw` } as CSSProperties}>
            <div className="pm-frame" style={pct(MAP_FRAME)} aria-hidden />
            {MAP_ZONES.map((z) => (
              <div key={z.id} className={`pm-zone pm-zone-${z.tone}`} style={pct(z)} />
            ))}
            {MAP_ZONES.filter((z) => z.title).map((z) => (
              <div key={`${z.id}-t`} className={`pm-zone-title pm-zone-title-${z.tone}`} style={{ left: `${fit(z).x}%`, width: `${fit(z).w}%`, top: `${(((z.titleY ?? 0) - F.y) / F.h) * 100}%` }}>
                {z.title}
              </div>
            ))}
            {stations.map((s) => (
              <div key={s.cell.id} className="pm-cell" style={pct(s.box)} data-station={s.cell.id}>
                {s.line ? (
                  <LineTile line={s.line} st={stationState([s.line.code, ...(s.cell.aliasLineCodes ?? [])], states)} now={now} celebrateMs={celebrateMs} sub={s.cell.subLabel} tone={s.cell.tone} />
                ) : (
                  <div className={`pm-unlinked pm-tone-${s.cell.tone}`} title="배치도에는 있으나 라인 기준정보와 연결이 확인되지 않음">
                    {s.cell.layoutLabel}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <aside className="floor-side">
          <h2>
            ACTIVE ANDON <span className="fs-n">{data ? active.length : "-"}</span>
          </h2>
          <div className="fs-legend" aria-label="테두리 색 = 이상 유형">
            <span className="fs-legend-t">테두리 = 유형</span>
            {CATEGORY_LEGEND.map((c) => (
              <span key={c.key} className={`fs-lg pm-c-${c.key}`}>{c.label}</span>
            ))}
          </div>
          {data && active.length === 0 && <div className="fs-clear">✔ 진행 중인 ANDON 없음</div>}
          <ol className="fs-list">
            {active.map((e) => (
              <li key={e.id}>
                <Link href={`/respond/${encodeURIComponent(e.id)}`} className={`fs-item fs-${e.status === "OPEN" ? "open" : "action"}`}>
                  <span className="fs-line">{e.lineName}</span>
                  <span className="fs-meta">
                    <i className={`fs-dot pm-c-${categoryKey(e.categoryCode)}`} />
                    {e.categoryName} · {e.status === "OPEN" ? "발생" : `${e.departments.map((d) => d.code).join("·")} ${STATUS_LABEL[e.status].ko}${e.acknowledgedBy ? ` · ${e.acknowledgedBy}` : ""}`}
                  </span>
                  <span className="fs-time">{formatElapsed(elapsedSeconds(e, now))}</span>
                </Link>
              </li>
            ))}
          </ol>
          {doneEvents.length > 0 && (
            <div className="fs-done">
              <h3>완료 · 24시간 표시 ({doneEvents.length})</h3>
              <ol className="fs-list">
                {doneEvents.map((e) => (
                  <li key={e.id}>
                    <Link href={`/respond/${encodeURIComponent(e.id)}`} className="fs-item fs-doneitem">
                      <span className="fs-line">{e.lineName}</span>
                      <span className="fs-meta">
                        <i className={`fs-dot pm-c-${categoryKey(e.categoryCode)}`} />
                        {e.categoryName} · 완료 {fmtTime(e.closedAt!)}{e.closedBy ? ` · ${e.closedBy}` : ""}
                      </span>
                      <span className="fs-time">{formatElapsed(elapsedSeconds(e, now))}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {unplaced.length > 0 && (
            <div className="fs-tray">
              <h3>배치 위치 확인 필요 · Position to confirm ({unplaced.length})</h3>
              <div className="fs-chips">
                {unplacedSorted.map((l) => (
                  <LineTile key={l.code} line={l} st={states.get(l.code)} now={now} celebrateMs={celebrateMs} compact />
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
