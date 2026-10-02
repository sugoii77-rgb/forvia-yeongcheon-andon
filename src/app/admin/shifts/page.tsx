"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { api, useMe } from "@/lib/client";
import { OWNERSHIP_VIEW_ROLES, type ShiftScheduleView } from "@/lib/domain";

// A/B shift schedule (admin): rule, anchor, the shift on duty now, anchor audit log, and — for
// SUPERVISOR / PLANT_MANAGER — the form to set the anchor. The server re-checks every permission.
const WD = ["일", "월", "화", "수", "목", "금", "토"];
/** "2026-10-05T08:00:00+09:00" → "10-05 (월) 08:00" — the string already carries plant-local time. */
function local(iso: string) {
  const [d, t] = iso.split("T");
  const wd = WD[new Date(`${d}T00:00:00Z`).getUTCDay()];
  return `${d.slice(5)} (${wd}) ${t.slice(0, 5)}`;
}
const isMonday = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).getUTCDay() === 1;

export default function AdminShiftsPage() {
  const { user, loaded } = useMe();
  const [data, setData] = useState<ShiftScheduleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [week, setWeek] = useState("");
  const [team, setTeam] = useState<"" | "A" | "B">("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const allowed = !!user && user.active && OWNERSHIP_VIEW_ROLES.includes(user.role);

  const load = useCallback(() => {
    api<ShiftScheduleView>("/api/admin/shift-schedule").then(setData, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const v = await api<ShiftScheduleView>("/api/admin/shift-schedule", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchorWeekMonday: week, anchorDayTeam: team }),
      });
      setData(v);
      setSaved("저장되었습니다 (변경 이력에 기록됨).");
      setConfirmed(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const n = data?.now;
  return (
    <>
      <TopBar />
      <main className="page" style={{ maxWidth: 760 }}>
        <h1>
          근무조 (A/B) 기준정보 <span className="muted" style={{ fontSize: 16 }}>Shift schedule</span>
        </h1>
        {!loaded && <p className="muted">불러오는 중…</p>}
        {loaded && !user && (
          <div className="card">
            <p>로그인이 필요합니다.</p>
            <Link className="btn btn-primary" href="/login?next=/admin/shifts">로그인</Link>
          </div>
        )}
        {loaded && user && !allowed && <div className="alert alert-error">이 화면은 GAP 리더 · 감독자 · 엔지니어 · 공장장 역할만 볼 수 있습니다.</div>}
        {error && <div className="alert alert-error">{error}</div>}
        {data && n && (
          <>
            <div className="card">
              <dl className="kv">
                <dt>시간대 Time zone</dt>
                <dd>{data.rule.timeZone}</dd>
                <dt>근무 시간</dt>
                <dd>주간 DAY {data.rule.dayStart}–{data.rule.nightStart} · 야간 NIGHT {data.rule.nightStart}–{data.rule.dayStart} (12시간)</dd>
                <dt>A/B 교대 규칙</dt>
                <dd>매주 월요일 {data.rule.dayStart} 주간 근무부터 A/B 주·야간 교대 (월요일 00:00–{data.rule.dayStart} 는 전주 일요일 야간)</dd>
                <dt>기준 주 (월요일)</dt>
                <dd>{data.anchor.anchorWeekMonday ?? <strong>미설정</strong>}</dd>
                <dt>기준 주 주간 근무조</dt>
                <dd>{data.anchor.anchorDayTeam ? `${data.anchor.anchorDayTeam}조` : <strong>미설정</strong>}</dd>
                {data.updatedAt && (
                  <>
                    <dt>마지막 변경</dt>
                    <dd>
                      {new Date(data.updatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} · {data.updatedBy}
                    </dd>
                  </>
                )}
              </dl>
            </div>

            <h2>현재 근무 Now</h2>
            {n.ok ? (
              <div className="card">
                <dl className="kv">
                  <dt>현재 근무조</dt>
                  <dd>
                    <strong style={{ fontSize: 20 }}>{n.activeTeam}조</strong> · {n.shiftType === "DAY" ? "주간 DAY" : "야간 NIGHT"} ({local(n.shiftStart)} – {local(n.shiftEnd)})
                  </dd>
                  <dt>이번 주</dt>
                  <dd>
                    {n.rotationWeekStart} 주: 주간 {n.dayTeam}조 / 야간 {n.nightTeam}조
                  </dd>
                  <dt>다음 근무 교대</dt>
                  <dd>{local(n.nextChangeAt)}</dd>
                  <dt>다음 A/B 주·야 교대</dt>
                  <dd>{local(n.nextRotationAt)}</dd>
                </dl>
              </div>
            ) : (
              <div className="alert alert-error">
                {n.code}: 기준 주와 주간 근무조가 설정되지 않아 현재 A/B 근무조를 자동으로 정할 수 없습니다. 시스템은 임의로 A 또는 B를
                선택하지 않으며, ANDON 호출은 정상적으로 동작합니다 (근무조 정보만 &apos;미확정&apos;으로 기록).
              </div>
            )}

            {data.canEdit && (
              <>
                <h2>기준 설정 Anchor</h2>
                <div className="card">
                  <p className="muted" style={{ fontSize: 14, marginTop: 0 }}>
                    UAP에 확인한 사실만 입력하세요: 어떤 주(월요일)에 어느 조가 주간(DAY)이었는지. 이 한 가지로 이전 · 이후 모든 주의 A/B가
                    계산됩니다. 변경은 이력에 남으며 기존 ANDON 기록은 바뀌지 않습니다.
                  </p>
                  <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "end" }}>
                    <label className="field" style={{ margin: 0 }}>
                      <span className="field-label">기준 주 월요일</span>
                      <input type="date" value={week} onChange={(e) => setWeek(e.target.value)} />
                    </label>
                    <label className="field" style={{ margin: 0 }}>
                      <span className="field-label">그 주 주간 근무조</span>
                      <select value={team} onChange={(e) => setTeam(e.target.value as "" | "A" | "B")}>
                        <option value="">선택</option>
                        <option value="A">A조</option>
                        <option value="B">B조</option>
                      </select>
                    </label>
                  </div>
                  {week && !isMonday(week) && <p className="alert alert-error">월요일 날짜를 선택하세요.</p>}
                  <label style={{ display: "block", margin: "12px 0" }}>
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> UAP 확인을 받은 값입니다
                  </label>
                  <button className="btn btn-primary" disabled={busy || !confirmed || !isMonday(week) || !team} onClick={save}>
                    {busy ? "저장 중…" : "저장"}
                  </button>
                  {saved && <p className="muted">{saved}</p>}
                </div>
              </>
            )}

            <h2>변경 이력 Audit</h2>
            {data.audit.length === 0 ? (
              <p className="muted">변경 이력 없음</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>일시</th>
                      <th>변경자</th>
                      <th>이전</th>
                      <th>변경</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.audit.map((a) => (
                      <tr key={a.id}>
                        <td>{new Date(a.changedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</td>
                        <td>
                          {a.changedBy} <span className="muted">({a.source})</span>
                        </td>
                        <td>{a.old.anchorWeekMonday ? `${a.old.anchorWeekMonday} 주간 ${a.old.anchorDayTeam}조` : "미설정"}</td>
                        <td>
                          {a.new.anchorWeekMonday} 주간 {a.new.anchorDayTeam}조
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
              <Link href="/admin/lines">라인 · 담당 기준정보</Link> · 관리자 PC: <code>npm run masterdata -- shift show</code>
            </p>
          </>
        )}
      </main>
    </>
  );
}
