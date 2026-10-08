"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CALL_ROLES } from "@/lib/domain";
import { TopBar } from "@/components/TopBar";
import { api, safeNextPath } from "@/lib/client";
import type { PublicUser } from "@/lib/domain";
import { GoogleLogin } from "@/components/GoogleLogin";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: PublicUser }>("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      // Full navigation so every component re-reads the session. Without an explicit target, GAP leaders /
      // supervisors go straight to the call screen (fewer taps), everybody else to their department's ANDONs.
      const home = CALL_ROLES.includes(res.user.role) ? "/operator" : "/respond";
      window.location.assign(safeNextPath(new URLSearchParams(window.location.search).get("next"), home));
    } catch (err) {
      setError((err as Error).message);
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar />
      <main className="page" style={{ maxWidth: 480 }}>
        <h1>로그인 <span className="muted" style={{ fontSize: 16 }}>Login</span></h1>
        <GoogleLogin />
        <h2 style={{fontSize:18}}>기존 로컬 계정</h2>
        <form className="card" onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">사번 또는 이메일</label>
            <input id="email" className="input" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="예) 12345678"
              value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">비밀번호</label>
            <input id="password" className="input" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <button className="btn btn-primary btn-big btn-block" disabled={busy}>
            {busy ? "확인 중…" : "로그인"}
          </button>
        </form>
        <p style={{ marginTop: 16 }}>
          <Link href="/reset">비밀번호를 잊으셨나요?</Link>
        </p>
        <p>
          계정은 관리자가 만듭니다. <b>사번</b>(사번이 없으면 안내받은 이메일)으로 로그인하세요. 문의: 시스템 담당자 오영환 책임(QC)
        </p>
        <p className="muted" style={{ fontSize: 14 }}>
          ANDON 호출은 로그인한 GAP 리더가, 조치(접수·조치·완료)는 로그인한 조치부서 담당자가 합니다.
        </p>
      </main>
    </>
  );
}
