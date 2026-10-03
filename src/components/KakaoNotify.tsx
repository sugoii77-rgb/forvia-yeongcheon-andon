"use client";
// /me → "카카오 알림": link the employee's OWN KakaoTalk ("나에게 보내기"), send a test, unlink.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

interface KakaoStatus {
  configured: boolean;
  linked: boolean;
  active: boolean;
  linkedAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
}

const REASON: Record<string, string> = {
  KAKAO_DENIED: "카카오 동의가 취소되었습니다.",
  KAKAO_SCOPE_MISSING: "'카카오톡 메시지 전송'에 동의해야 알림을 받을 수 있습니다.",
  KAKAO_ALREADY_LINKED: "이 카카오 계정은 다른 직원에게 이미 연결되어 있습니다.",
  KAKAO_INVALID_STATE: "연결 요청이 만료되었습니다. 다시 시도하세요.",
  KAKAO_SESSION_CHANGED: "연결을 시작한 계정으로 다시 로그인한 뒤 시도하세요.",
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "-");

export function KakaoNotify() {
  const [status, setStatus] = useState<KakaoStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Result of the OAuth round trip (/api/notify/kakao/callback → /me?kakao=…). The card renders only after
  // the status has loaded on the client, so reading the URL here causes no hydration mismatch.
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search);
    const r = q.get("kakao");
    if (r === "linked") return { ok: true, text: "카카오 알림이 연결되었습니다. 카카오톡 '나와의 채팅'에 확인 메시지를 보냈습니다." };
    if (r === "error") return { ok: false, text: REASON[q.get("reason") ?? ""] ?? "카카오 연결에 실패했습니다. 다시 시도하세요." };
    return null;
  });

  const load = useCallback(
    () =>
      api<KakaoStatus>("/api/notify/kakao").then(
        (s) => setStatus(s),
        () => setStatus(null),
      ),
    [],
  );

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("kakao")) window.history.replaceState(null, "", "/me");
    load();
  }, [load]);

  async function act(kind: "start" | "test" | "unlink") {
    setBusy(kind);
    setMsg(null);
    try {
      if (kind === "start") {
        const { url } = await api<{ url: string }>("/api/notify/kakao/start", { method: "POST" });
        window.location.href = url;
        return;
      }
      if (kind === "unlink" && !window.confirm("카카오 알림 연결을 해제할까요? ANDON 알림을 더 이상 받지 않습니다.")) return;
      await api(`/api/notify/kakao/${kind}`, { method: "POST" });
      setMsg({ ok: true, text: kind === "test" ? "테스트 메시지를 보냈습니다. 카카오톡 '나와의 채팅'을 확인하세요." : "카카오 알림 연결을 해제했습니다." });
      await load();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!status?.configured) return null;
  return (
    <div className="card" data-testid="kakao-notify">
      <h2 style={{ marginTop: 0 }}>카카오 알림 <span className="muted" style={{ fontSize: 14 }}>KakaoTalk</span></h2>
      <p className="muted" style={{ fontSize: 14 }}>
        내 부서에 ANDON이 발생하면 본인 카카오톡 &lsquo;나와의 채팅&rsquo;으로 알림을 받습니다. 본인 카카오 계정으로만 연결할 수 있습니다.
      </p>
      <dl className="kv">
        <dt>상태</dt>
        <dd data-testid="kakao-state">
          {!status.linked ? "연결되지 않음" : status.active ? "✔ 연결됨" : "⚠ 다시 연결 필요"}
        </dd>
        {status.linked && (
          <>
            <dt>연결 일시</dt>
            <dd>{fmt(status.linkedAt)}</dd>
            <dt>마지막 발송</dt>
            <dd>{fmt(status.lastSentAt)}</dd>
          </>
        )}
        {status.lastError && (
          <>
            <dt>최근 오류</dt>
            <dd>{status.lastError}</dd>
          </>
        )}
      </dl>
      {msg && <div className={`alert ${msg.ok ? "alert-ok" : "alert-error"}`}>{msg.text}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        {(!status.linked || !status.active) && (
          <button className="btn btn-primary" onClick={() => act("start")} disabled={!!busy}>
            {busy === "start" ? "카카오로 이동 중…" : status.linked ? "카카오 다시 연결" : "카카오 알림 연결"}
          </button>
        )}
        {status.linked && status.active && (
          <button className="btn" onClick={() => act("test")} disabled={!!busy}>
            {busy === "test" ? "보내는 중…" : "테스트 보내기"}
          </button>
        )}
        {status.linked && (
          <button className="btn" onClick={() => act("unlink")} disabled={!!busy}>
            {busy === "unlink" ? "해제 중…" : "연결 해제"}
          </button>
        )}
      </div>
    </div>
  );
}
