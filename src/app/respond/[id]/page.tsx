"use client";
import { use, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { StatusBadge } from "@/components/StatusBadge";
import Link from "next/link";
import { api, fmtDateTime, fmtDuration, fmtTime, usePolling, useServerNow } from "@/lib/client";
import {
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

interface Detail {
  event: AndonEvent;
  transitions: AndonTransition[];
  notifications: NotificationLogEntry[];
  responsibility: Responsibility | null;
  eligibleResponders: ResponderSummary[];
  /** Logged-in user and whether the SERVER allows them to act on this event. */
  viewer: { user: PublicUser; canRespond: boolean } | null;
  serverTime: string;
}

const ROUTING_LABEL: Record<string, string> = {
  LINE_PROCESS_CATEGORY: "공정별 규칙",
  LINE_CATEGORY: "라인별 규칙",
  CATEGORY_DEFAULT: "유형 기본값",
  GAP_LEADER_CALL: "GAP 리더 호출",
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

const ACTION_LABEL: Record<string, string> = {
  CREATE: "발생 (CREATE)",
  ACKNOWLEDGE: "접수 (ACKNOWLEDGE)",
  ACTION: "조치 (ACTION)",
  CLOSE: "완료 (CLOSE)",
};

export default function RespondDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, clockOffsetMs, refresh } = usePolling<Detail>(`/api/andons/${encodeURIComponent(id)}`, 5000);
  const now = useServerNow(clockOffsetMs);

  const [mode, setMode] = useState<"ACTION" | "CLOSE" | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function run(action: TransitionAction) {
    if (busy) return;
    if (!data?.viewer?.canRespond) {
      setResult({ ok: false, message: "이 ANDON을 조치할 권한이 없습니다." });
      return;
    }
    if (action !== "ACKNOWLEDGE" && !comment.trim()) {
      setResult({ ok: false, message: "조치 내용을 입력하세요." });
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
      setResult({ ok: true, message: `저장됨 → ${STATUS_LABEL[res.event.status].ko} (${res.event.status})` });
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
          {error ? <div className="alert alert-error">불러오기 실패: {error}</div> : <p className="muted">불러오는 중…</p>}
        </main>
      </>
    );
  }

  const e = data.event;
  const actions = allowedActions(e.status);
  const end = e.closedAt ? new Date(e.closedAt).getTime() : now;
  const elapsed = (end - new Date(e.createdAt).getTime()) / 1000;
  const eligible = data.eligibleResponders;
  const viewer = data.viewer;
  const responsibleLabel = e.departments.length > 1
    ? e.departmentLabel
    : data.responsibility
    ? data.responsibility.effectiveDepartmentCode === data.responsibility.departmentCode
      ? data.responsibility.departmentLabel
      : `${data.responsibility.departmentLabel} → ${data.responsibility.effectiveDepartmentCode}`
    : e.departmentLabel;

  return (
    <>
      <TopBar />
      <main className="page">
        {error && <div className="alert alert-warn">자동 갱신 실패 (표시된 정보가 최신이 아닐 수 있음): {error}</div>}

        <div className={`event-item sig-${signalColor(e.status)}`} style={{ borderLeftWidth: 12 }}>
          <div className="row">
            <StatusBadge status={e.status} />
            <span className="muted">{e.id}</span>
            <span className="spacer" />
            <span className="muted">{e.closedAt ? "소요" : "경과"}</span>
            <strong style={{ fontSize: 24, fontVariantNumeric: "tabular-nums" }}>{fmtDuration(elapsed)}</strong>
          </div>
          <div className="title" style={{ fontSize: 22 }}>
            {e.lineName} / {e.processName}
          </div>
          <div style={{ fontSize: 19, margin: "6px 0" }}>{e.description}</div>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>이상 유형</dt>
            <dd>{e.categoryName}</dd>
            {e.situations.length > 0 && (
              <>
                <dt>상황</dt>
                <dd>{e.situations.join(", ")}</dd>
              </>
            )}
            <dt>담당 부서</dt>
            <dd>
              {responsibleLabel}
              {data.responsibility && (
                <span className="muted" style={{ fontWeight: 500 }}>
                  {" "}
                  ({ROUTING_LABEL[data.responsibility.matchedBy] ?? data.responsibility.matchedBy})
                </span>
              )}
            </dd>
            <dt>발생</dt>
            <dd>
              {fmtDateTime(e.createdAt)} · {e.createdBy}
            </dd>
            <dt>접수</dt>
            <dd>{e.acknowledgedAt ? `${fmtDateTime(e.acknowledgedAt)} · ${e.acknowledgedBy}` : "-"}</dd>
            <dt>완료</dt>
            <dd>{e.closedAt ? `${fmtDateTime(e.closedAt)} · ${e.closedBy}` : "-"}</dd>
            {e.correctiveAction && (
              <>
                <dt>시정 조치</dt>
                <dd>{e.correctiveAction}</dd>
              </>
            )}
          </dl>
          {e.photoFile && (
            <a href={`/api/photos/${e.photoFile}`} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/photos/${e.photoFile}`}
                alt="현장 사진"
                style={{ marginTop: 12, maxWidth: "100%", maxHeight: 320, borderRadius: 10, display: "block" }}
              />
            </a>
          )}
        </div>

        {e.status !== "CLOSED" && (
          <section className="card" style={{ marginTop: 14 }}>
            {!viewer && (
              <div className="alert alert-warn">
                조치하려면 로그인하세요.{" "}
                <Link href={`/login?next=${encodeURIComponent(`/respond/${e.id}`)}`}>로그인</Link> ·{" "}
                <Link href={`/register?next=${encodeURIComponent(`/respond/${e.id}`)}`}>회원가입</Link>
              </div>
            )}
            {viewer && (
              <div style={{ marginBottom: 12 }}>
                조치자 <strong>{viewer.user.name}</strong>{" "}
                <span className="muted">· {viewer.user.departmentLabel} · {viewer.user.roleName}</span>
              </div>
            )}
            {viewer && !viewer.canRespond && (
              <div className="alert alert-warn">
                {!viewer.user.active
                  ? "비활성 계정입니다. 조치할 수 없습니다."
                  : !viewer.user.canRespond
                    ? "이 역할은 조치 권한이 없습니다."
                    : `이 ANDON은 ${responsibleLabel} 부서 담당입니다 (내 부서: ${viewer.user.departmentLabel}).`}
              </div>
            )}
            {eligible.length === 0 && <div className="alert alert-error">이 부서에 등록된 담당자가 없습니다 (기준정보 확인 필요).</div>}

            {viewer?.canRespond && mode && (
              <div className="field">
                <label htmlFor="comment">{mode === "CLOSE" ? "시정 조치 내용 (Corrective action)" : "조치 내용 (Action note)"}</label>
                <textarea
                  id="comment"
                  className="textarea"
                  maxLength={1000}
                  value={comment}
                  onChange={(ev) => setComment(ev.target.value)}
                  placeholder={mode === "CLOSE" ? "예) 체결 토크 재조정 후 전수 재검사 완료" : "예) 현장 도착, 원인 확인 중"}
                  autoFocus
                />
              </div>
            )}

            {result && <div className={`alert ${result.ok ? "alert-ok" : "alert-error"}`}>{result.message}</div>}

            {viewer?.canRespond && (
            <div className="row">
              {actions.includes("ACKNOWLEDGE") && (
                <button className="btn btn-ack btn-big btn-block" disabled={busy} onClick={() => run("ACKNOWLEDGE")}>
                  {busy ? "처리 중…" : "ACKNOWLEDGE · 접수"}
                </button>
              )}
              {!mode && actions.includes("ACTION") && (
                <button className="btn btn-action btn-big" style={{ flex: 1 }} disabled={busy} onClick={() => setMode("ACTION")}>
                  ACTION · 조치 입력
                </button>
              )}
              {!mode && actions.includes("CLOSE") && (
                <button className="btn btn-close btn-big" style={{ flex: 1 }} disabled={busy} onClick={() => setMode("CLOSE")}>
                  CLOSE · 완료
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
                    {busy ? "저장 중…" : mode === "CLOSE" ? "완료 저장 (CLOSE)" : "조치 저장 (ACTION)"}
                  </button>
                  <button className="btn btn-big" style={{ flex: 1 }} disabled={busy} onClick={() => setMode(null)}>
                    취소
                  </button>
                </>
              )}
            </div>
            )}
          </section>
        )}
        {e.status === "CLOSED" && result?.ok && <div className="alert alert-ok">{result.message}</div>}

        <h2>이력 History</h2>
        <ol className="timeline">
          {data.transitions.map((t) => (
            <li key={t.id} className={`sig-${signalColor(t.toStatus)}`}>
              <strong>{ACTION_LABEL[t.action] ?? t.action}</strong>{" "}
              <span className="muted">
                {fmtDateTime(t.createdAt)} · {t.userName}
                {t.userDepartmentLabel ? ` (${t.userDepartmentLabel} · ${t.userRole})` : ""} ·{" "}
                {t.fromStatus ?? "—"} → {t.toStatus}
              </span>
              {(t.deviceId || t.clientIp) && (
                <div className="muted" style={{ fontSize: 13 }}>
                  기기 {t.deviceId ? t.deviceId.slice(0, 12) : "-"}
                  {t.clientIp ? ` · ${t.clientIp}` : ""}
                  {deviceSummary(t.userAgent) ? ` · ${deviceSummary(t.userAgent)}` : ""}
                </div>
              )}
              {t.comment && <div>{t.comment}</div>}
            </li>
          ))}
        </ol>

        <h2>알림 기록 Notifications</h2>
        {data.notifications.length === 0 ? (
          <p className="muted">알림 기록 없음</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>채널</th>
                  <th>수신자</th>
                  <th>결과</th>
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
