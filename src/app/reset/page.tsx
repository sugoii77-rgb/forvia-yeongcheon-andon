"use client";
// 비밀번호 재설정 (self-service): 사번 / 이메일 → 인증번호 to the own KakaoTalk → code + new password.
import { useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { api } from "@/lib/client";

export default function ResetPage() {
  const [login, setLogin] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [form, setForm] = useState({ code: "", newPassword: "", newPasswordConfirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function request(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: string }>("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login }),
      });
      setSent(r.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, ...form }),
      });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar />
      <main className="page" style={{ maxWidth: 520 }}>
        <h1>비밀번호 재설정 <span className="muted" style={{ fontSize: 16 }}>Reset password</span></h1>
        {done ? (
          <div className="card">
            <div className="alert alert-ok">비밀번호를 바꿨습니다. 새 비밀번호로 로그인하세요.</div>
            <Link className="btn btn-primary" href="/login">로그인</Link>
          </div>
        ) : (
          <div className="card">
            <p className="muted" style={{ marginTop: 0, fontSize: 15 }}>
              카카오 알림을 연결해 둔 계정은 카카오톡 &lsquo;나와의 채팅&rsquo;으로 받은 인증번호로 직접 비밀번호를 바꿀 수 있습니다.
              카카오 알림을 연결하지 않았다면 시스템 담당자에게 재설정을 요청하세요.
            </p>
            <form onSubmit={request}>
              <div className="field">
                <label htmlFor="login">사번 또는 이메일</label>
                <input id="login" className="input" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="예) 12345678"
                  value={login} onChange={(e) => setLogin(e.target.value)} required disabled={!!sent} />
              </div>
              {!sent && (
                <button className="btn btn-primary btn-block" type="submit" disabled={busy || !login.trim()}>
                  {busy ? "보내는 중…" : "카카오톡으로 인증번호 받기"}
                </button>
              )}
            </form>
            {sent && (
              <form onSubmit={confirm} style={{ marginTop: 12 }}>
                <div className="alert alert-ok" style={{ fontSize: 15 }}>{sent}</div>
                <div className="field">
                  <label htmlFor="code">인증번호 (6자리)</label>
                  <input id="code" className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}"
                    value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, "") })} required />
                </div>
                <div className="field">
                  <label htmlFor="newPassword">새 비밀번호</label>
                  <input id="newPassword" className="input" type="password" autoComplete="new-password" maxLength={128}
                    value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} required />
                  <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>8자 이상, 영문자와 숫자 포함</div>
                </div>
                <div className="field">
                  <label htmlFor="newPasswordConfirm">새 비밀번호 확인</label>
                  <input id="newPasswordConfirm" className="input" type="password" autoComplete="new-password" maxLength={128}
                    value={form.newPasswordConfirm} onChange={(e) => setForm({ ...form, newPasswordConfirm: e.target.value })} required />
                </div>
                <div className="row">
                  <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "변경 중…" : "비밀번호 변경"}</button>
                  <button className="btn" type="button" disabled={busy} onClick={() => { setSent(null); setForm({ code: "", newPassword: "", newPasswordConfirm: "" }); }}>
                    인증번호 다시 받기
                  </button>
                </div>
              </form>
            )}
            {error && <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}
          </div>
        )}
      </main>
    </>
  );
}
