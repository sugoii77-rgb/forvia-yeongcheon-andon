"use client";
import { useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { StatusBadge } from "@/components/StatusBadge";
import { fmtDuration, fmtTime, useMe, usePolling, useServerNow } from "@/lib/client";
import { signalColor, type AndonEvent } from "@/lib/domain";

export default function RespondListPage() {
  const { user, loaded } = useMe();
  const [allDepts, setAllDepts] = useState(false);

  // Which events belong to me is decided on the server from my session (mine=1).
  const mine = !!user && user.canRespond && !allDepts;
  const url = loaded ? `/api/andons?scope=active${mine ? "&mine=1" : ""}` : null;
  const { data, error, clockOffsetMs } = usePolling<{ events: AndonEvent[] }>(url, 3000);
  const now = useServerNow(clockOffsetMs);

  return (
    <>
      <TopBar />
      <main className="page">
        <h1>담당자 조치 <span className="muted" style={{ fontSize: 16 }}>Responder</span></h1>

        {loaded && !user && (
          <div className="alert alert-warn">
            조치(접수·조치·완료)하려면 로그인하세요.{" "}
            <Link href="/login?next=/respond">로그인</Link> · <Link href="/register">회원가입</Link>
          </div>
        )}
        {user && (
          <div className="card" style={{ marginBottom: 12 }}>
            <strong>{user.name}</strong> <span className="muted">· {user.departmentLabel} · {user.roleName}</span>
            {!user.active && <div className="alert alert-error">비활성 계정입니다. 조치할 수 없습니다.</div>}
            {user.active && !user.canRespond && <div className="alert alert-warn">이 역할은 조치 권한이 없습니다.</div>}
          </div>
        )}

        <div className="row" style={{ marginBottom: 12 }}>
          <strong>진행 중 ANDON {mine ? `· ${user?.departmentLabel} 담당` : "· 전체"}</strong>
          <span className="spacer" />
          {user?.canRespond && (
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={allDepts} onChange={(e) => setAllDepts(e.target.checked)} />
              전체 부서 보기
            </label>
          )}
        </div>

        {error && <div className="alert alert-error">목록 갱신 실패: {error}</div>}
        {data && data.events.length === 0 && <p className="muted">진행 중인 ANDON이 없습니다.</p>}

        <div className="event-list">
          {data?.events.map((e) => (
            <Link key={e.id} href={`/respond/${encodeURIComponent(e.id)}`} className={`event-item sig-${signalColor(e.status)}`}>
              <div className="row">
                <StatusBadge status={e.status} />
                <span className="muted">{e.id}</span>
                <span className="spacer" />
                <strong style={{ fontVariantNumeric: "tabular-nums" }}>
                  {fmtDuration((now - new Date(e.createdAt).getTime()) / 1000)}
                </strong>
              </div>
              <div className="title">
                {e.lineName} / {e.processName} · {e.categoryName}
              </div>
              <div>{e.description}</div>
              <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>
                발생 {fmtTime(e.createdAt)} · 담당 {e.departmentLabel}
              </div>
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}
