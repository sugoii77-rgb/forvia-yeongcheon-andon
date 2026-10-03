"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { api, useMe } from "@/lib/client";
import { OWNERSHIP_VIEW_ROLES } from "@/lib/domain";
import { GoogleLogin } from "@/components/GoogleLogin";
import { KakaoNotify } from "@/components/KakaoNotify";

export default function MePage() {
  const router = useRouter();
  const { user, loaded } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    setBusy(true);
    try {
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
        <h1>내 정보 <span className="muted" style={{ fontSize: 16 }}>My information</span></h1>
        {!loaded && <p className="muted">불러오는 중…</p>}
        {loaded && !user && (
          <div className="card">
            <p>로그인되어 있지 않습니다.</p>
            <div className="row">
              <Link className="btn btn-primary" href="/login?next=/me">로그인</Link>
              <Link className="btn" href="/register">회원가입</Link>
            </div>
          </div>
        )}
        {user?.email && user.active && !user.googleLinked && <GoogleLogin linking />}
        {user && (
          <div className="card">
            <dl className="kv" style={{ fontSize: 18 }}>
              <dt>이름</dt>
              <dd>{user.name}</dd>
              <dt>사번</dt>
              <dd>{user.employeeId ?? "미등록 · Google 연결 시 등록"}</dd>
              <dt>Google 로그인</dt>
              <dd>{user.googleLinked ? "연결됨" : "연결되지 않음"}</dd>
              <dt>로컬 로그인 이메일</dt>
              <dd>{user.email ?? "-"}</dd>
              <dt>부서</dt>
              <dd>{user.departmentLabel}</dd>
              <dt>역할</dt>
              <dd>
                {user.roleName} ({user.role})
              </dd>
              <dt>상태</dt>
              <dd>{user.active ? "✔ 활성 (active)" : "✖ 비활성 — 조치할 수 없습니다"}</dd>
            </dl>
            <p className="muted" style={{ fontSize: 14, marginTop: 12 }}>
              {user.canRespond
                ? `${user.departmentLabel} 부서에 배정된 ANDON을 접수·조치·완료할 수 있습니다.`
                : "이 계정은 ANDON 조치 권한이 없습니다."}{" "}
              역할·부서 변경은 관리자에게 요청하세요.
            </p>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="row" style={{ marginTop: 12 }}>
              <Link className="btn btn-primary" href="/respond">내 부서 ANDON 보기</Link>
              {user.active && OWNERSHIP_VIEW_ROLES.includes(user.role) && (
                <Link className="btn" href="/admin/lines">라인 · 담당 기준정보</Link>
              )}
              {user.active && OWNERSHIP_VIEW_ROLES.includes(user.role) && (
                <Link className="btn" href="/admin/shifts">근무조 (A/B)</Link>
              )}
              <button className="btn" onClick={logout} disabled={busy}>
                {busy ? "로그아웃 중…" : "로그아웃"}
              </button>
            </div>
          </div>
        )}
        {user?.active && <KakaoNotify />}
      </main>
    </>
  );
}
