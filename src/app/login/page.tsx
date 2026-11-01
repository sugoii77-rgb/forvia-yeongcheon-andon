"use client";
import { useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { api, safeNextPath } from "@/lib/client";
import type { PublicUser } from "@/lib/domain";
import { GoogleLogin } from "@/components/GoogleLogin";
import { useLang, useT } from "@/lib/i18n";

export default function LoginPage() {
  const lang = useLang();
  const t = useT();
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
      // Full navigation so every component re-reads the session. Without an explicit target: the main menu
      // (plant request 2026-10-13 — same first screen as the app icon).
      window.location.assign(safeNextPath(new URLSearchParams(window.location.search).get("next"), "/"));
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
        <h1>{t("로그인", "Log in")}</h1>
        <GoogleLogin />
        <h2 style={{fontSize:18}}>{t("기존 로컬 계정", "ANDON account")}</h2>
        <form className="card" onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">{t("사번 또는 이메일", "Employee no. or e-mail")}</label>
            <input id="email" className="input" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder={t("예) 12345678", "e.g. name@forvia.com")}
              value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">{t("비밀번호", "Password")}</label>
            <input id="password" className="input" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <button className="btn btn-primary btn-big btn-block" disabled={busy}>
            {busy ? t("확인 중…", "Checking…") : t("로그인", "Log in")}
          </button>
        </form>
        <p style={{ marginTop: 16 }}>
          <Link href="/reset">{t("비밀번호를 잊으셨나요?", "Forgot your password?")}</Link>
        </p>
        {lang === "en" ? (
          <p>Accounts are created by the administrator. Log in with the e-mail you were given. Contact: Young-Hwan OH (QC), system owner.</p>
        ) : (
          <p>
            계정은 관리자가 만듭니다. <b>사번</b>(사번이 없으면 안내받은 이메일)으로 로그인하세요. 문의: 시스템 담당자 오영환 책임(QC)
          </p>
        )}
        <p className="muted" style={{ fontSize: 14 }}>
          {t(
            "ANDON 호출은 로그인한 GAP 리더가, 조치(접수·조치·완료)는 로그인한 조치부서 담당자가 합니다.",
            "ANDON calls are made by logged-in GAP leaders; acknowledge / action / close by the responsible department.",
          )}
        </p>
      </main>
    </>
  );
}
