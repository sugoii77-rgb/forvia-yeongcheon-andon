"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { api, safeNextPath } from "@/lib/client";
import type { MasterData, PublicUser } from "@/lib/domain";
import { GoogleLogin } from "@/components/GoogleLogin";

export default function RegisterPage() {
  const [departments, setDepartments] = useState<MasterData["departments"]>([]);
  const [open, setOpen] = useState<boolean | null>(null);
  const [form, setForm] = useState({ name: "", email: "", department: "", password: "", passwordConfirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<MasterData>("/api/meta").then(
      (m) => {
        setDepartments(m.departments);
        setOpen(m.selfRegistration);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (form.password !== form.passwordConfirm) {
      setError("비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api<{ user: PublicUser }>("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      window.location.assign(safeNextPath(new URLSearchParams(window.location.search).get("next"), "/me"));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar />
      <main className="page" style={{ maxWidth: 520 }}>
        <h1>회원가입 <span className="muted" style={{ fontSize: 16 }}>Register</span></h1>
        {open === false && (
          <div className="card" data-testid="registration-closed">
            <p>
              <b>회원가입은 받지 않습니다.</b> 계정은 관리자가 미리 만들어 두었습니다. <b>사번</b>(사번이 없으면 안내받은
              이메일)과 안내받은 임시 비밀번호로 로그인하세요.
            </p>
            <p className="muted" style={{ fontSize: 14 }}>
              비밀번호를 잊었으면 로그인 화면의 &lsquo;비밀번호를 잊으셨나요?&rsquo;를, 계정이 없으면 시스템 담당자 오영환 책임(QC)에게 문의하세요.
            </p>
            <Link className="btn btn-primary" href="/login">로그인으로</Link>
          </div>
        )}
        {open && <GoogleLogin />}
        {open && (
        <form className="card" onSubmit={submit}>
          <div className="field">
            <label htmlFor="name">이름</label>
            <input id="name" className="input" autoComplete="name" maxLength={40} value={form.name} onChange={set("name")} required />
          </div>
          <div className="field">
            <label htmlFor="email">이메일</label>
            <input id="email" className="input" type="email" autoComplete="email" inputMode="email" maxLength={254}
              value={form.email} onChange={set("email")} required />
          </div>
          <div className="field">
            <label htmlFor="department">부서 <span className="muted" style={{ fontWeight: 500, fontSize: 14 }}>Department</span></label>
            <select id="department" className="select" value={form.department} onChange={set("department")} required>
              <option value="">— 부서 선택 —</option>
              {departments.map((d) => (
                <option key={d.code} value={d.code}>{d.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="password">비밀번호</label>
            <input id="password" className="input" type="password" autoComplete="new-password" maxLength={128}
              value={form.password} onChange={set("password")} required />
            <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>8자 이상, 영문자와 숫자 포함</div>
          </div>
          <div className="field">
            <label htmlFor="passwordConfirm">비밀번호 확인</label>
            <input id="passwordConfirm" className="input" type="password" autoComplete="new-password" maxLength={128}
              value={form.passwordConfirm} onChange={set("passwordConfirm")} required />
          </div>
          <p className="muted" style={{ fontSize: 14 }}>
            가입하면 선택한 부서의 <strong>담당자(RESPONDER)</strong>로 등록되어 해당 부서 ANDON을 조치할 수 있습니다.
            GAP 리더·감독자 등 다른 역할은 관리자가 지정합니다.
          </p>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <button className="btn btn-primary btn-big btn-block" disabled={busy}>
            {busy ? "등록 중…" : "회원가입"}
          </button>
        </form>
        )}
        <p style={{ marginTop: 16 }}>
          이미 계정이 있으신가요? <Link href="/login">로그인</Link>
        </p>
      </main>
    </>
  );
}
