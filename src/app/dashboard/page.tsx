"use client";
// Shop-floor display v2 — PLANT MAP ANDON. Answers one question from several meters away:
// "WHERE is the abnormal condition right now?" Lines keep their physical position (plant layout page 2,
// src/config/plantLayout.ts); an abnormal line lights up in place, it never moves. Public display:
// line, problem category, state and elapsed time only — no people.
import Link from "next/link";
import { fmtTime, usePolling, useServerNow } from "@/lib/client";
import { MAP_LANDMARKS, MAP_ZONES } from "@/config/plantLayout";
import { STATUS_LABEL, type AndonEvent, type MasterData } from "@/lib/domain";
import { CATEGORY_LEGEND, categoryKey, displayLines, stationState, elapsedSeconds, formatElapsed, lineStates, placeLines, shiftLabel, sortActive, type LineState, type MapLine } from "@/lib/plantMap";

type PublicShift = { status: "RESOLVED"; team: "A" | "B"; type: "DAY" | "NIGHT"; operationalDate: string; shiftEnd: string } | { status: "UNRESOLVED"; reason: string };
interface BoardResponse {
  events: AndonEvent[];
  counts: { open: number; inProgress: number; closedToday: number; createdToday: number };
  serverTime: string;
  shift?: PublicShift;
}

const POLL_MS = 2000;
const STALE_MS = 10000;
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

const pct = (b: { x: number; y: number; w: number; h: number }) => ({ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` });
const stateText = (s: LineState) => (s.state === "OPEN" ? "발생 OPEN" : STATUS_LABEL[s.lead!.status].ko + " " + (s.lead!.status === "ACKNOWLEDGED" ? "ACK" : "IN ACTION"));

function LineTile({ line, st, now, compact, sub, tone }: { line: MapLine; st: LineState | undefined; now: number; compact?: boolean; sub?: string; tone?: string }) {
  if (!st) {
    return (
      <div className={`pm-line pm-normal${tone ? ` pm-tone-${tone}` : ""}${compact ? " pm-chip" : ""}`} data-line={line.code} data-state="NORMAL" title={sub}>
        <span className="pm-name">{line.name}</span>
        {sub && <span className="pm-sub">{sub}</span>}
      </div>
    );
  }
  const e = st.lead!;
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
  const { data, lastSuccess, clockOffsetMs } = usePolling<BoardResponse>("/api/andons?scope=board", POLL_MS);
  const { data: meta } = usePolling<MasterData>("/api/meta", META_MS);
  const now = useServerNow(clockOffsetMs);
  const stale = lastSuccess == null || now - clockOffsetMs - lastSuccess > STALE_MS;

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
  const normalLines = shownStates.filter((x) => !x).length;

  return (
    <main className="floor">
      <header className="floor-head">
        <Link href="/" className="floor-title">
          DIGITAL ANDON <small>· YEONGCHEON</small>
        </Link>
        <span className="fc fc-open" data-testid="count-open">● OPEN {meta ? openLines : "-"}</span>
        <span className="fc fc-action" data-testid="count-action">● IN ACTION {meta ? actionLines : "-"}</span>
        <span className="fc fc-normal" data-testid="count-normal">● NORMAL {meta ? normalLines : "-"}</span>
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
          <span className="conn conn-ok">● LIVE</span>
        )}
      </header>

      <div className="floor-body">
        <section className="pm-wrap" aria-label="Plant map">
          <div className={`pm${active.length > 0 ? " pm-has-alarm" : ""}`}>
            {MAP_ZONES.map((z) => (
              <div key={z.id} className={`pm-zone pm-zone-${z.tone}`} style={pct(z)} />
            ))}
            {MAP_ZONES.filter((z) => z.title).map((z) => (
              <div key={`${z.id}-t`} className={`pm-zone-title pm-zone-title-${z.tone}`} style={{ left: `${z.x}%`, width: `${z.w}%`, top: `${z.titleY}%` }}>
                {z.title}
              </div>
            ))}
            {MAP_LANDMARKS.map((l) => (
              <div key={l.id} className={`pm-landmark${l.vertical ? " pm-vertical" : ""}`} style={pct(l)}>
                <span>{l.label}</span>
              </div>
            ))}
            {stations.map((s) => (
              <div key={s.cell.id} className="pm-cell" style={pct(s.box)} data-station={s.cell.id}>
                {s.line ? (
                  <LineTile line={s.line} st={stationState([s.line.code, ...(s.cell.aliasLineCodes ?? [])], states)} now={now} sub={s.cell.subLabel} tone={s.cell.tone} />
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
                    {e.categoryName} · {e.status === "OPEN" ? "발생" : `${e.departmentCode} ${STATUS_LABEL[e.status].ko}`}
                  </span>
                  <span className="fs-time">{formatElapsed(elapsedSeconds(e, now))}</span>
                </Link>
              </li>
            ))}
          </ol>
          {unplaced.length > 0 && (
            <div className="fs-tray">
              <h3>배치 위치 확인 필요 · Position to confirm ({unplaced.length})</h3>
              <div className="fs-chips">
                {unplacedSorted.map((l) => (
                  <LineTile key={l.code} line={l} st={states.get(l.code)} now={now} compact />
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
