"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { api, useMe } from "@/lib/client";
import { OWNERSHIP_VIEW_ROLES, canViewSetupStatus } from "@/lib/domain";
import { GoogleLogin } from "@/components/GoogleLogin";
import { KakaoNotify } from "@/components/KakaoNotify";
import { PasswordChange } from "@/components/PasswordChange";
import { PushNotify, pushOffBeforeLogout } from "@/components/PushNotify";
import { departmentLabel, roleName, useLang, useT } from "@/lib/i18n";

export default function MePage() {
  const router = useRouter();
  const { user, loaded } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lang = useLang();
  const t = useT();

  async function logout() {
    setBusy(true);
    try {
      await pushOffBeforeLogout();
      await api("/api/auth/logout", { method: "POST" });
      router.push("/login");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar />
      <main className="page" style={{ maxWidth: 520 }}>
        <h1>{t("내 정보", "My account")}</h1>
        {!loaded && <p className="muted">{t("불러오는 중…", "Loading…")}</p>}
        {loaded && !user && (
          <div className="card">
            <p>{t("로그인되어 있지 않습니다.", "You are not logged in.")}</p>
            <div className="row">
              <Link className="btn btn-primary" href="/login?next=/me">{t("로그인", "Log in")}</Link>
            </div>
          </div>
        )}
        {user?.email && user.active && !user.googleLinked && <GoogleLogin linking />}
        {user && (
          <div className="card">
            <dl className="kv" style={{ fontSize: 18 }}>
              <dt>{t("이름", "Name")}</dt>
              <dd>{user.name}</dd>
              <dt>{t("사번", "Employee no.")}</dt>
              <dd>{user.employeeId ?? t("미등록 · Google 연결 시 등록", "-")}</dd>
              <dt>{t("Google 로그인", "Google login")}</dt>
              <dd>{user.googleLinked ? t("연결됨", "linked") : t("연결되지 않음", "not linked")}</dd>
              <dt>{t("로컬 로그인 이메일", "Login e-mail")}</dt>
              <dd>{user.email ?? "-"}</dd>
              <dt>{t("부서", "Department")}</dt>
              <dd>{departmentLabel(lang, user.departmentLabel)}</dd>
              <dt>{t("역할", "Role")}</dt>
              <dd>
                {roleName(lang, user.role, user.roleName)} ({user.role})
              </dd>
              <dt>{t("상태", "Status")}</dt>
              <dd>{user.active ? t("✔ 활성 (active)", "✔ active") : t("✖ 비활성 — 조치할 수 없습니다", "✖ deactivated")}</dd>
            </dl>
            <p className="muted" style={{ fontSize: 14, marginTop: 12 }}>
              {user.canRespond
                ? t(`${user.departmentLabel} 부서에 배정된 ANDON을 접수·조치·완료할 수 있습니다.`, `You can acknowledge, act on and close ANDON of ${departmentLabel(lang, user.departmentLabel)}.`)
                : t("이 계정은 ANDON 조치 권한이 없습니다.", "This is a view-only account.")}{" "}
              {t("역할·부서 변경은 관리자에게 요청하세요.", "Ask the administrator to change role or department.")}
            </p>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="row" style={{ marginTop: 12 }}>
              <Link className="btn btn-primary" href="/respond">{t("내 부서 ANDON 보기", "Active ANDON")}</Link>
              {user.active && OWNERSHIP_VIEW_ROLES.includes(user.role) && (
                <Link className="btn" href="/admin/lines">{t("라인 · 담당 기준정보", "Lines · owners")}</Link>
              )}
              {user.active && OWNERSHIP_VIEW_ROLES.includes(user.role) && (
                <Link className="btn" href="/admin/shifts">{t("근무조 (A/B)", "Shifts (A/B)")}</Link>
              )}
              {canViewSetupStatus(user) && <Link className="btn" href="/admin/setup">{t("설정 현황 (로그인·카카오·알림음)", "Setup status")}</Link>}
              <button className="btn" onClick={logout} disabled={busy}>
                {busy ? t("로그아웃 중…", "Logging out…") : t("로그아웃", "Log out")}
              </button>
            </div>
          </div>
        )}
        {user?.active && <PushNotify />}
        {user?.active && <KakaoNotify />}
        {user?.active && (user.email || user.employeeId) && <PasswordChange />}
      </main>
    </>
  );
}
