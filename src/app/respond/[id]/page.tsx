"use client";
import { use, useEffect, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { StatusBadge } from "@/components/StatusBadge";
import { ResponderPicker } from "@/components/ResponderPicker";
import { api, fmtDateTime, fmtDuration, fmtTime, usePolling, useServerNow, useStoredState } from "@/lib/client";
import {
  STATUS_LABEL,
  allowedActions,
  signalColor,
  type AndonEvent,
  type AndonTransition,
  type MasterData,
  type NotificationLogEntry,
  type TransitionAction,
} from "@/lib/domain";

interface Detail {
  event: AndonEvent;
  transitions: AndonTransition[];
  notifications: NotificationLogEntry[];
  serverTime: string;
}

const ACTION_LABEL: Record<string, string> = {
  CREATE: "발생 (CREATE)",
  ACKNOWLEDGE: "접수 (ACKNOWLEDGE)",
  ACTION: "조치 (ACTION)",
  CLOSE: "완료 (CLOSE)",
};

export default function RespondDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [meta, setMeta] = useState<MasterData | null>(null);
  const [me, setMe] = useStoredState("andon.responder.name", "");
  const { data, error, clockOffsetMs, refresh } = usePolling<Detail>(`/api/andons/${encodeURIComponent(id)}`, 5000);
  const now = useServerNow(clockOffsetMs);

  const [mode, setMode] = useState<"ACTION" | "CLOSE" | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    api<MasterData>("/api/meta").then(setMeta, () => {});
  }, []);

  async function run(action: TransitionAction) {
    if (busy) return;
    if (!me) {
      setResult({ ok: false, message: "먼저 담당자 이름을 선택하세요." });
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
        body: JSON.stringify({ action, userName: me, comment: action === "ACKNOWLEDGE" ? undefined : comment.trim() }),
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
            <dt>담당 부서</dt>
            <dd>{e.departmentName}</dd>
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
            {meta && <ResponderPicker meta={meta} value={me} onChange={setMe} />}

            {mode && (
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
          </section>
        )}
        {e.status === "CLOSED" && result?.ok && <div className="alert alert-ok">{result.message}</div>}

        <h2>이력 History</h2>
        <ol className="timeline">
          {data.transitions.map((t) => (
            <li key={t.id} className={`sig-${signalColor(t.toStatus)}`}>
              <strong>{ACTION_LABEL[t.action] ?? t.action}</strong>{" "}
              <span className="muted">
                {fmtDateTime(t.createdAt)} · {t.userName} · {t.fromStatus ?? "—"} → {t.toStatus}
              </span>
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
