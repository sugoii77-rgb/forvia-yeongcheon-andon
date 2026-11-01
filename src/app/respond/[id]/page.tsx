"use client";
import { use, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { StatusBadge } from "@/components/StatusBadge";
import Link from "next/link";
import { api, fmtDateTime, fmtDuration, fmtTime, usePolling, useServerNow } from "@/lib/client";
import {
  lineWithProcess,
  STATUS_LABEL,
  allowedActions,
  signalColor,
  type AndonEvent,
  type AndonTransition,
  type NotificationLogEntry,
  type PublicUser,
  type ResponderSummary,
  type Responsibility,
  type TransitionAction,
} from "@/lib/domain";
import { categoryName, departmentLabel, roleName, useLang, useT } from "@/lib/i18n";

interface Detail {
  event: AndonEvent;
  transitions: AndonTransition[];
  notifications: NotificationLogEntry[];
  responsibility: Responsibility | null;
  eligibleResponders: ResponderSummary[];
  /** Logged-in user and whether the SERVER allows them to act on this event. */
  viewer: { user: PublicUser; canRespond: boolean; actions?: TransitionAction[] } | null;
  serverTime: string;
}

const ROUTING_LABEL: Record<string, [string, string]> = {
  LINE_PROCESS_CATEGORY: ["공정별 규칙", "process rule"],
  LINE_CATEGORY: ["라인별 규칙", "line rule"],
  CATEGORY_DEFAULT: ["유형 기본값", "category default"],
  GAP_LEADER_CALL: ["GAP 리더 호출", "chosen by the GAP leader"],
};

/** "Android · Chrome" style summary of a user-agent string (display only). */
function deviceSummary(ua: string | null): string {
  if (!ua) return "";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua)
    ? "Edge"
    : /SamsungBrowser/.test(ua)
      ? "Samsung"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : /Firefox\//.test(ua)
            ? "Firefox"
            : /node/i.test(ua)
              ? "script"
              : "";
  return [os, br].filter(Boolean).join(" · ");
}

const ACTION_LABEL: Record<string, [string, string]> = {
  CREATE: ["발생 (CREATE)", "Raised"],
  ACKNOWLEDGE: ["접수 (ACKNOWLEDGE)", "Acknowledged"],
  ACTION: ["조치 (ACTION)", "Action"],
  CLOSE: ["완료 (CLOSE)", "Closed"],
};

export default function RespondDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, clockOffsetMs, refresh } = usePolling<Detail>(`/api/andons/${encodeURIComponent(id)}`, 15000); // + at once on an ANDON push / back on screen
  const now = useServerNow(clockOffsetMs);
  const lang = useLang();
  const tr = useT();

  const [mode, setMode] = useState<"ACTION" | "CLOSE" | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function run(action: TransitionAction) {
    if (busy) return;
    if (!data?.viewer?.canRespond) {
      setResult({ ok: false, message: tr("이 ANDON을 조치할 권한이 없습니다.", "You cannot act on this ANDON.") });
      return;
    }
    if (action !== "ACKNOWLEDGE" && !comment.trim()) {
      setResult({ ok: false, message: tr("조치 내용을 입력하세요.", "Please describe the action taken.") });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await api<{ event: AndonEvent }>(`/api/andons/${encodeURIComponent(id)}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No identity in the body: the server uses the logged-in user (session cookie).
        body: JSON.stringify({ action, comment: action === "ACKNOWLEDGE" ? undefined : comment.trim() }),
      });
      setResult({ ok: true, message: `${tr("저장됨", "Saved")} → ${STATUS_LABEL[res.event.status][lang]} (${res.event.status})` });
      setComment("");
      setMode(null);
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(false);
      refresh();
    }
  }

  if (!data) {
    return (
      <>
        <TopBar />
        <main className="page">
          {error ? <div className="alert alert-error">{tr("불러오기 실패", "Could not load")}: {error}</div> : <p className="muted">{tr("불러오는 중…", "Loading…")}</p>}
        </main>
      </>
    );
  }

  const e = data.event;
  // the server decides per action (a QC event is closed by UAP); older servers: by status only
  const actions = data.viewer?.actions ?? allowedActions(e.status);
  const closeByUap = allowedActions(e.status).includes("CLOSE") && !actions.includes("CLOSE") && e.departments.some((d) => d.code !== "UAP");
  // Equipment (MT) events: MT 수리 시작 (yellow) and repair notes; UAP closes (green) — plant 2026-10-15
  const preventive = e.situations?.includes("예방보전") ?? false; // MT closes its planned work itself
  const repair = !preventive && e.departments.some((d) => d.code === "MT") && !e.departments.some((d) => d.code === "QC" || d.code === "PCL" || d.code === "HSE");
  const end = e.closedAt ? new Date(e.closedAt).getTime() : now;
  const elapsed = (end - new Date(e.createdAt).getTime()) / 1000;
  const eligible = data.eligibleResponders;
  const viewer = data.viewer;
  const responsibleLabel = departmentLabel(lang, e.departments.length > 1
    ? e.departmentLabel
    : data.responsibility
    ? data.responsibility.effectiveDepartmentCode === data.responsibility.departmentCode
      ? data.responsibility.departmentLabel
      : `${data.responsibility.departmentLabel} → ${data.responsibility.effectiveDepartmentCode}`
    : e.departmentLabel);

  return (
    <>
      <TopBar />
      <main className="page">
        {error && <div className="alert alert-warn">{tr("자동 갱신 실패 (표시된 정보가 최신이 아닐 수 있음)", "Refresh failed (the information shown may be out of date)")}: {error}</div>}

        <div className={`event-item sig-${signalColor(e.status)}`} style={{ borderLeftWidth: 12 }}>
          <div className="row">
            <StatusBadge status={e.status} />
            <span className="muted">{e.id}</span>
            <span className="spacer" />
            <span className="muted">{e.closedAt ? tr("소요", "Duration") : tr("경과", "Elapsed")}</span>
            <strong style={{ fontSize: 24, fontVariantNumeric: "tabular-nums" }}>{fmtDuration(elapsed)}</strong>
          </div>
          <div className="title" style={{ fontSize: 22 }}>
            {lineWithProcess(e.lineName, e.processName)}
          </div>
          <div style={{ fontSize: 19, margin: "6px 0" }}>{e.description}</div>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>{tr("이상 유형", "Problem type")}</dt>
            <dd>{categoryName(lang, e.categoryCode, e.categoryName)}</dd>
            {e.situations.length > 0 && (
              <>
                <dt>{tr("상황", "Situation")}</dt>
                <dd>{e.situations.join(", ")}</dd>
              </>
            )}
            <dt>{tr("담당 부서", "Responsible dept.")}</dt>
            <dd>
              {responsibleLabel}
              {data.responsibility && (
                <span className="muted" style={{ fontWeight: 500 }}>
                  {" "}
                  ({ROUTING_LABEL[data.responsibility.matchedBy]?.[lang === "en" ? 1 : 0] ?? data.responsibility.matchedBy})
                </span>
              )}
            </dd>
            <dt>{tr("발생", "Raised")}</dt>
            <dd>
              {fmtDateTime(e.createdAt)} · {e.createdBy}
            </dd>
            <dt>{tr("접수", "Acknowledged")}</dt>
            <dd>{e.acknowledgedAt ? `${fmtDateTime(e.acknowledgedAt)} · ${e.acknowledgedBy}` : "-"}</dd>
            <dt>{tr("완료", "Closed")}</dt>
            <dd>{e.closedAt ? `${fmtDateTime(e.closedAt)} · ${e.closedBy}` : "-"}</dd>
            {e.correctiveAction && (
              <>
                <dt>{tr("시정 조치", "Corrective action")}</dt>
                <dd>{e.correctiveAction}</dd>
              </>
            )}
          </dl>
          {e.photoFile && (
            <a href={`/api/photos/${e.photoFile}`} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/photos/${e.photoFile}`}
                alt={tr("현장 사진", "Photo from the line")}
                style={{ marginTop: 12, maxWidth: "100%", maxHeight: 320, borderRadius: 10, display: "block" }}
              />
            </a>
          )}
        </div>

        {e.status !== "CLOSED" && (
          <section className="card" style={{ marginTop: 14 }}>
            {!viewer && (
              <div className="alert alert-warn">
                {tr("조치하려면 로그인하세요.", "Log in to respond.")}{" "}
                <Link href={`/login?next=${encodeURIComponent(`/respond/${e.id}`)}`}>{tr("로그인", "Log in")}</Link>
              </div>
            )}
            {viewer && (
              <div style={{ marginBottom: 12 }}>
                {tr("조치자", "Signed in as")} <strong>{viewer.user.name}</strong>{" "}
                <span className="muted">· {departmentLabel(lang, viewer.user.departmentLabel)} · {roleName(lang, viewer.user.role, viewer.user.roleName)}</span>
              </div>
            )}
            {viewer && !viewer.canRespond && (
              <div className="alert alert-warn">
                {!viewer.user.active
                  ? tr("비활성 계정입니다. 조치할 수 없습니다.", "This account is deactivated.")
                  : !viewer.user.canRespond
                    ? tr("이 역할은 조치 권한이 없습니다.", "View only — this account cannot acknowledge or close ANDON.")
                    : tr(`이 ANDON은 ${responsibleLabel} 부서 담당입니다 (내 부서: ${viewer.user.departmentLabel}).`, `This ANDON belongs to ${responsibleLabel} (your department: ${departmentLabel(lang, viewer.user.departmentLabel)}).`)}
              </div>
            )}
            {viewer?.canRespond && closeByUap && (
              <div className="alert alert-warn">{tr(`최종 완료(Close)는 생산(UAP)이 확인 후 처리합니다. ${repair ? "수리 내용" : "조치 내용"}을 입력해 주세요.`, `Production (UAP) checks and closes it. Please enter the ${repair ? "repair" : "action"} note.`)}</div>
            )}
            {eligible.length === 0 && <div className="alert alert-error">{tr("이 부서에 등록된 담당자가 없습니다 (기준정보 확인 필요).", "No responder registered for this department (check the master data).")}</div>}

            {viewer?.canRespond && mode && (
              <div className="field">
                <label htmlFor="comment">{mode === "CLOSE" ? (repair ? tr("수리 확인 내용", "Repair check") : tr("시정 조치 내용 (Corrective action)", "Corrective action")) : repair ? tr("수리 내용", "Repair note") : tr("조치 내용 (Action note)", "Action note")}</label>
                <textarea
                  id="comment"
                  className="textarea"
                  maxLength={1000}
                  value={comment}
                  onChange={(ev) => setComment(ev.target.value)}
                  placeholder={mode === "CLOSE" ? tr("예) 체결 토크 재조정 후 전수 재검사 완료", "e.g. torque readjusted, 100 % re-inspected") : tr("예) 현장 도착, 원인 확인 중", "e.g. on site, checking the cause")}
                  autoFocus
                />
              </div>
            )}

            {result && <div className={`alert ${result.ok ? "alert-ok" : "alert-error"}`}>{result.message}</div>}

            {viewer?.canRespond && (
            <div className="row">
              {actions.includes("ACKNOWLEDGE") && (
                <button className="btn btn-ack btn-big btn-block" disabled={busy} onClick={() => run("ACKNOWLEDGE")}>
                  {busy ? tr("처리 중…", "Working…") : repair ? tr("수리 시작", "Start repair") : tr("ACKNOWLEDGE · 접수", "ACKNOWLEDGE")}
                </button>
              )}
              {!mode && actions.includes("ACTION") && (
                <button className="btn btn-action btn-big" style={{ flex: 1 }} disabled={busy} onClick={() => setMode("ACTION")}>
                  {repair ? tr("수리 내용 입력", "Enter repair note") : tr("ACTION · 조치 입력", "ACTION · enter note")}
                </button>
              )}
              {!mode && actions.includes("CLOSE") && (
                <button className="btn btn-close btn-big" style={{ flex: 1 }} disabled={busy} onClick={() => setMode("CLOSE")}>
                  {repair ? tr("수리 완료 확인 (CLOSE)", "Confirm repair (CLOSE)") : preventive ? tr("예방보전 완료", "Preventive maintenance done") : tr("CLOSE · 완료", "CLOSE")}
                </button>
              )}
              {mode && (
                <>
                  <button
                    className={`btn btn-big ${mode === "CLOSE" ? "btn-close" : "btn-action"}`}
                    style={{ flex: 2 }}
                    disabled={busy}
                    onClick={() => run(mode)}
                  >
                    {busy ? tr("저장 중…", "Saving…") : mode === "CLOSE" ? (repair ? tr("수리 완료 확인 저장", "Save repair check") : tr("완료 저장 (CLOSE)", "Save & close")) : repair ? tr("수리 내용 저장", "Save repair note") : tr("조치 저장 (ACTION)", "Save action")}
                  </button>
                  <button className="btn btn-big" style={{ flex: 1 }} disabled={busy} onClick={() => setMode(null)}>
                    {tr("취소", "Cancel")}
                  </button>
                </>
              )}
            </div>
            )}
          </section>
        )}
        {e.status === "CLOSED" && result?.ok && <div className="alert alert-ok">{result.message}</div>}

        <h2>{tr("이력 History", "History")}</h2>
        <ol className="timeline">
          {data.transitions.map((t) => (
            <li key={t.id} className={`sig-${signalColor(t.toStatus)}`}>
              <strong>{ACTION_LABEL[t.action]?.[lang === "en" ? 1 : 0] ?? t.action}</strong>{" "}
              <span className="muted">
                {fmtDateTime(t.createdAt)} · {t.userName}
                {t.userDepartmentLabel ? ` (${departmentLabel(lang, t.userDepartmentLabel)} · ${t.userRole})` : ""} ·{" "}
                {t.fromStatus ?? "—"} → {t.toStatus}
              </span>
              {/* 조치 시각 = when the note was saved (plant 2026-10-24) */}
              {t.action === "ACTION" && (
                <div>
                  {tr("조치 시각", "Action at")} <strong>{fmtDateTime(t.createdAt)}</strong>
                  {e.acknowledgedAt && <span className="muted"> · {tr("접수 후", "after ACK")} {fmtDuration((new Date(t.createdAt).getTime() - new Date(e.acknowledgedAt).getTime()) / 1000)}</span>}
                </div>
              )}
              {(t.deviceId || t.clientIp) && (
                <div className="muted" style={{ fontSize: 13 }}>
                  {tr("기기", "Device")} {t.deviceId ? t.deviceId.slice(0, 12) : "-"}
                  {t.clientIp ? ` · ${t.clientIp}` : ""}
                  {deviceSummary(t.userAgent) ? ` · ${deviceSummary(t.userAgent)}` : ""}
                </div>
              )}
              {t.comment && <div>{t.comment}</div>}
            </li>
          ))}
        </ol>

        <h2>{tr("알림 기록 Notifications", "Notifications sent")}</h2>
        {data.notifications.length === 0 ? (
          <p className="muted">{tr("알림 기록 없음", "No notifications")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{tr("시각", "Time")}</th>
                  <th>{tr("채널", "Channel")}</th>
                  <th>{tr("수신자", "Recipient")}</th>
                  <th>{tr("결과", "Result")}</th>
                </tr>
              </thead>
              <tbody>
                {data.notifications.map((n) => (
                  <tr key={n.id}>
                    <td>{fmtTime(n.createdAt)}</td>
                    <td>{n.provider}</td>
                    <td>{n.recipient}</td>
                    <td>{n.status === "SENT" ? "✔ SENT" : `✖ FAILED ${n.error ?? ""}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
