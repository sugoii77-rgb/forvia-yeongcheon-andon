"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { api, useMe } from "@/lib/client";
import { OWNERSHIP_VIEW_ROLES, type LineOwnershipList, type LinePerson } from "@/lib/domain";

// Line master with ownership (Supervisor, GAP leader of shift A / B). Administrative view only:
// login + GAP_LEADER / SUPERVISOR / ENGINEER / PLANT_MANAGER (checked again by the API). Names only.
const person = (p: LinePerson | null) => (p ? p.name : <span className="muted">—</span>);

export default function AdminLinesPage() {
  const { user, loaded } = useMe();
  const [data, setData] = useState<LineOwnershipList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allowed = !!user && user.active && OWNERSHIP_VIEW_ROLES.includes(user.role);

  useEffect(() => {
    if (!allowed) return;
    api<LineOwnershipList>("/api/admin/lines").then(setData, (e: Error) => setError(e.message));
  }, [allowed]);

  const groups = data
    ? [...data.areas.map((a) => ({ key: a.code, title: a.name })), { key: "", title: "시범 라인 (Prototype)" }]
        .map((g) => ({ ...g, lines: data.lines.filter((l) => (l.uapAreaCode ?? "") === g.key) }))
        .filter((g) => g.lines.length > 0)
    : [];
  const shiftNote = data?.shifts.some((s) => !s.startTime || !s.endTime);

  return (
    <>
      <TopBar />
      <main className="page page-wide">
        <h1>
          라인 · 담당 기준정보 <span className="muted" style={{ fontSize: 16 }}>Line ownership master</span>
        </h1>
        {!loaded && <p className="muted">불러오는 중…</p>}
        {loaded && !user && (
          <div className="card">
            <p>로그인이 필요합니다.</p>
            <Link className="btn btn-primary" href="/login?next=/admin/lines">로그인</Link>
          </div>
        )}
        {loaded && user && !allowed && (
          <div className="alert alert-error">이 화면은 GAP 리더 · 감독자 · 엔지니어 · 공장장 역할만 볼 수 있습니다.</div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        {data && (
          <>
            <p className="muted" style={{ fontSize: 14 }}>
              감독자(SV)와 조별 GAP 리더는 라인 <strong>소유(담당자)</strong> 정보입니다. ANDON의 책임 부서는 이상 유형 ·
              라우팅 규칙으로 정해지며 이 화면과 별개입니다.
              {shiftNote && " A/B 조 근무 시간이 아직 확정되지 않아, 현재 근무 중인 조는 표시하지 않습니다."}
            </p>
            {groups.map((g) => (
              <section key={g.key || "prototype"}>
                <h2>{g.title}</h2>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>라인 Line</th>
                        <th>감독자 Supervisor</th>
                        {data.shifts.map((s) => (
                          <th key={s.code}>GAP 리더 {s.nameKo}</th>
                        ))}
                        <th>상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.lines.map((l) => (
                        <tr key={l.lineCode}>
                          <td>
                            <strong>{l.lineName}</strong> <span className="muted" style={{ fontSize: 13 }}>{l.lineCode}</span>
                          </td>
                          <td>{person(l.supervisor)}</td>
                          {data.shifts.map((s) => (
                            <td key={s.code}>{person(l.gapLeaders[s.code] ?? null)}</td>
                          ))}
                          <td>{l.lineActive ? "사용" : <span className="muted">미사용</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
            <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
              <Link href="/admin/shifts">근무조 (A/B) 기준정보</Link> · 변경: 관리자 PC에서 <code>npm run import:uap -- &lt;워크북.xlsx&gt;</code> 또는{" "}
              <code>npm run masterdata -- assign …</code> (RUNBOOK.md §7).
            </p>
          </>
        )}
      </main>
    </>
  );
}
