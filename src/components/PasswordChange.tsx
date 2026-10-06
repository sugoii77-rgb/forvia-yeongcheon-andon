"use client";
// /me → "비밀번호 변경": own local password (e.g. after an administrator reset). Other devices are logged out.
import { useState } from "react";
import { api } from "@/lib/client";

const EMPTY = { currentPassword: "", newPassword: "", newPasswordConfirm: "" };

export function PasswordChange() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      setForm(EMPTY);
      setOpen(false);
      setMsg({ ok: true, text: "비밀번호를 변경했습니다. 다른 기기에서는 다시 로그인해야 합니다." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-testid="password-change">
      <h2 style={{ marginTop: 0 }}>비밀번호 변경 <span className="muted" style={{ fontSize: 14 }}>Password</span></h2>
      {msg && <div className={`alert ${msg.ok ? "alert-ok" : "alert-error"}`}>{msg.text}</div>}
      {!open ? (
        <button className="btn" onClick={() => { setOpen(true); setMsg(null); }}>비밀번호 변경</button>
      ) : (
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="currentPassword">현재 비밀번호</label>
            <input id="currentPassword" className="input" type="password" autoComplete="current-password" maxLength={128}
              value={form.currentPassword} onChange={set("currentPassword")} required />
          </div>
          <div className="field">
            <label htmlFor="newPassword">새 비밀번호</label>
            <input id="newPassword" className="input" type="password" autoComplete="new-password" maxLength={128}
              value={form.newPassword} onChange={set("newPassword")} required />
            <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>8자 이상, 영문자와 숫자 포함</div>
          </div>
          <div className="field">
            <label htmlFor="newPasswordConfirm">새 비밀번호 확인</label>
            <input id="newPasswordConfirm" className="input" type="password" autoComplete="new-password" maxLength={128}
              value={form.newPasswordConfirm} onChange={set("newPasswordConfirm")} required />
          </div>
          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "변경 중…" : "변경하기"}</button>
            <button className="btn" type="button" disabled={busy} onClick={() => { setOpen(false); setForm(EMPTY); }}>취소</button>
          </div>
        </form>
      )}
    </div>
  );
}
