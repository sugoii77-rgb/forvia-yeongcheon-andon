"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { StatusBadge } from "@/components/StatusBadge";
import { ResponderPicker } from "@/components/ResponderPicker";
import { api, fmtDuration, fmtTime, usePolling, useServerNow, useStoredState } from "@/lib/client";
import { signalColor, type AndonEvent, type MasterData } from "@/lib/domain";

export default function RespondListPage() {
  const [meta, setMeta] = useState<MasterData | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [me, setMe] = useStoredState("andon.responder.name", "");
  const [allDepts, setAllDepts] = useState(false);

  useEffect(() => {
    api<MasterData>("/api/meta").then(setMeta, (e: Error) => setMetaError(e.message));
  }, []);

  const myDept = meta?.users.find((u) => u.name === me)?.departmentCode ?? "";
  const url = `/api/andons?scope=active${!allDepts && myDept ? `&department=${myDept}` : ""}`;
  const { data, error, clockOffsetMs } = usePolling<{ events: AndonEvent[] }>(url, 3000);
  const now = useServerNow(clockOffsetMs);

  return (
    <>
      <TopBar />
      <main className="page">
        <h1>담당자 조치 <span className="muted" style={{ fontSize: 16 }}>Responder</span></h1>
        {metaError && <div className="alert alert-error">기준정보 로드 실패: {metaError}</div>}
        {meta && <ResponderPicker meta={meta} value={me} onChange={setMe} />}

        <div className="row" style={{ marginBottom: 12 }}>
          <strong>
            진행 중 ANDON {myDept && !allDepts ? `· ${meta?.departments.find((d) => d.code === myDept)?.nameKo} 담당` : "· 전체"}
          </strong>
          <span className="spacer" />
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={allDepts} onChange={(e) => setAllDepts(e.target.checked)} />
            전체 부서 보기
          </label>
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
                발생 {fmtTime(e.createdAt)} · 담당 {e.departmentName}
              </div>
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}
