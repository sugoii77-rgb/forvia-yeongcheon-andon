"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
      await api<{ user: PublicUser }>("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      // Full navigation so every component re-reads the session.
      window.location.assign(safeNextPath(new URLSearchParams(window.location.search).get("next")));
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
            <label htmlFor="email">이메일</label>
            <input id="email" className="input" type="email" autoComplete="username" inputMode="email"
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
          계정이 없으신가요? <Link href="/register" onClick={(e) => { e.preventDefault(); router.push(`/register${window.location.search}`); }}>회원가입</Link>
        </p>
        <p className="muted" style={{ fontSize: 14 }}>
          ANDON 호출은 로그인한 GAP 리더가, 조치(접수·조치·완료)는 로그인한 조치부서 담당자가 합니다.
        </p>
      </main>
    </>
  );
}
