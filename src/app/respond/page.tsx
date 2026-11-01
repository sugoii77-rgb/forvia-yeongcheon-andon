"use client";
import { useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { StatusBadge } from "@/components/StatusBadge";
import { fmtDuration, fmtTime, useMe, usePolling, useServerNow } from "@/lib/client";
import { lineWithProcess, signalColor, type AndonEvent } from "@/lib/domain";
import { categoryName, departmentLabel, roleName, useLang, useT } from "@/lib/i18n";

export default function RespondListPage() {
  const { user, loaded } = useMe();
  const [allDepts, setAllDepts] = useState(false);

  // Which events belong to me is decided on the server from my session (mine=1).
  const mine = !!user && user.canRespond && !allDepts;
  const url = loaded ? `/api/andons?scope=active${mine ? "&mine=1" : ""}` : null;
  const { data, error, clockOffsetMs } = usePolling<{ events: AndonEvent[] }>(url, 15000); // + at once on an ANDON push / back on screen (2026-10-29)
  const now = useServerNow(clockOffsetMs);
  const lang = useLang();
  const t = useT();

  return (
    <>
      <TopBar />
      <main className="page">
        <h1>{t("담당자 조치", "Respond")} <span className="muted" style={{ fontSize: 16 }}>{t("Responder", "active ANDON")}</span></h1>

        {loaded && !user && (
          <div className="alert alert-warn">
            {t("조치(접수·조치·완료)하려면 로그인하세요.", "Log in to acknowledge, act on and close ANDON.")}{" "}
            <Link href="/login?next=/respond">{t("로그인", "Log in")}</Link>
          </div>
        )}
        {user && (
          <div className="card" style={{ marginBottom: 12 }}>
            <strong>{user.name}</strong> <span className="muted">· {departmentLabel(lang, user.departmentLabel)} · {roleName(lang, user.role, user.roleName)}</span>
            {!user.active && <div className="alert alert-error">{t("비활성 계정입니다. 조치할 수 없습니다.", "This account is deactivated.")}</div>}
            {user.active && !user.canRespond && <div className="alert alert-warn">{t("이 역할은 조치 권한이 없습니다.", "View only — this account cannot acknowledge or close ANDON.")}</div>}
          </div>
        )}

        <div className="row" style={{ marginBottom: 12 }}>
          <strong>{t("진행 중 ANDON", "Active ANDON")} {mine ? `· ${departmentLabel(lang, user?.departmentLabel ?? "")}` : t("· 전체", "· all departments")}</strong>
          <span className="spacer" />
          {user?.canRespond && (
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={allDepts} onChange={(e) => setAllDepts(e.target.checked)} />
              {t("전체 부서 보기", "Show all departments")}
            </label>
          )}
        </div>

        {error && <div className="alert alert-error">{t("목록 갱신 실패", "Could not refresh the list")}: {error}</div>}
        {data && data.events.length === 0 && <p className="muted">{t("진행 중인 ANDON이 없습니다.", "No active ANDON.")}</p>}

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
                {lineWithProcess(e.lineName, e.processName)} · {categoryName(lang, e.categoryCode, e.categoryName)}
              </div>
              <div>{e.description}</div>
              <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>
                {t("발생", "Raised")} {fmtTime(e.createdAt)} · {t("담당", "Dept.")} {departmentLabel(lang, e.departmentLabel)}
              </div>
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}
