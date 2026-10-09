"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { api, useMe } from "@/lib/client";
import { canViewSetupStatus, type SetupStatusPerson } from "@/lib/domain";

// Setup status of every account: logged in / KakaoTalk linked / phone push (sound) on. For the launch follow-up
// by the system owner and the 팀장s. Names and states only (checked again by the API).
const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\.\s?/g, ".").replace(/\.(\d\d:)/, " $1")
    : null;

type Step = "login" | "kakao" | "push";
const done = (p: SetupStatusPerson, s: Step) => (s === "login" ? !!p.lastLoginAt : s === "kakao" ? !!p.kakaoLinkedAt : p.pushDevices > 0);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

function Cell({ ok, label }: { ok: boolean; label?: string | null }) {
  return ok ? (
    <span style={{ color: "var(--ok, #1f9d55)", fontWeight: 700 }}>✔<span className="muted" style={{ fontWeight: 400, marginLeft: 4, fontSize: 12 }}>{label}</span></span>
  ) : (
    <span style={{ color: "var(--danger, #c0392b)", fontWeight: 700 }}>✖</span>
  );
}

export default function SetupStatusPage() {
  const { user, loaded } = useMe();
  const [people, setPeople] = useState<SetupStatusPerson[] | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dept, setDept] = useState<string>("ALL");
  const [onlyTodo, setOnlyTodo] = useState(false);
  const [copied, setCopied] = useState(false);
  const allowed = canViewSetupStatus(user);

  const load = useCallback(() => {
    setError(null);
    api<{ people: SetupStatusPerson[]; at: string }>("/api/admin/setup-status").then(
      (r) => { setPeople(r.people); setAt(r.at); },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  const depts = useMemo(() => {
    const m = new Map<string, { code: string; label: string; list: SetupStatusPerson[] }>();
    for (const p of people ?? []) {
      if (!m.has(p.departmentCode)) m.set(p.departmentCode, { code: p.departmentCode, label: p.departmentLabel, list: [] });
      m.get(p.departmentCode)!.list.push(p);
    }
    return [...m.values()];
  }, [people]);

  const shown = (people ?? [])
    .filter((p) => dept === "ALL" || p.departmentCode === dept)
    .filter((p) => !onlyTodo || !done(p, "login") || !done(p, "kakao") || !done(p, "push"));

  async function copyTodo() {
    const scope = (people ?? []).filter((p) => dept === "ALL" || p.departmentCode === dept);
    const line = (title: string, list: SetupStatusPerson[]) => (list.length ? `▶ ${title} (${list.length}명): ${list.map((p) => p.name).join(", ")}` : "");
    const text = [
      `[Digital ANDON 설정 현황] ${dept === "ALL" ? "전체" : depts.find((d) => d.code === dept)?.label} · ${fmt(at)} 기준`,
      line("로그인 필요", scope.filter((p) => !done(p, "login"))),
      line("카카오 알림 연결 필요", scope.filter((p) => done(p, "login") && !done(p, "kakao"))),
      line("알림음(이 기기 알림 켜기) 필요", scope.filter((p) => done(p, "login") && !done(p, "push"))),
      "접속: https://forvia-yeongcheon-andon.vercel.app → 로그인 → 오른쪽 위 이름 → '내 정보'",
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt("아래 내용을 복사하세요", text);
    }
  }

  return (
    <>
      <TopBar />
      <main className="page page-wide">
        <h1>
          설정 현황 <span className="muted" style={{ fontSize: 16 }}>Login · KakaoTalk · Sound</span>
        </h1>
        {!loaded && <p className="muted">불러오는 중…</p>}
        {loaded && !user && (
          <div className="card">
            <p>로그인이 필요합니다.</p>
            <Link className="btn btn-primary" href="/login?next=/admin/setup">로그인</Link>
          </div>
        )}
        {loaded && user && !allowed && <div className="alert alert-error">이 화면은 GL · SV · 공장장과 각 부서 팀장만 볼 수 있습니다.</div>}
        {error && <div className="alert alert-error">{error}</div>}

        {people && (
          <>
            <p className="muted" style={{ fontSize: 14 }}>
              {fmt(at)} 기준 · 사용 중인 계정 {people.length}개. <b>로그인</b> = 한 번 이상 로그인, <b>카카오</b> = 카카오 알림 연결,{" "}
              <b>알림음</b> = &lsquo;이 기기 알림 켜기&rsquo;를 한 휴대폰 수. 연락처는 표시하지 않습니다.
            </p>

            <div className="table-wrap">
              <table className="table" data-testid="setup-summary">
                <thead>
                  <tr><th>부서</th><th>계정</th><th>로그인</th><th>카카오</th><th>알림음</th></tr>
                </thead>
                <tbody>
                  {[...depts, { code: "ALL", label: "전체", list: people }].map((d) => {
                    const n = d.list.length;
                    const c = (s: Step) => d.list.filter((p) => done(p, s)).length;
                    return (
                      <tr key={d.code} onClick={() => setDept(d.code)} style={{ cursor: "pointer", fontWeight: d.code === "ALL" ? 800 : undefined, background: dept === d.code ? "var(--brand-soft, #e7eef9)" : undefined }}>
                        <td>{d.label}</td>
                        <td>{n}</td>
                        {(["login", "kakao", "push"] as Step[]).map((s) => (
                          <td key={s}>
                            {c(s)} <span className="muted" style={{ fontSize: 12 }}>({pct(c(s), n)}%)</span>
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="row" style={{ margin: "12px 0", flexWrap: "wrap", gap: 6 }}>
              {[{ code: "ALL", label: "전체" }, ...depts].map((d) => (
                <button key={d.code} className={`btn ${dept === d.code ? "btn-primary" : ""}`} onClick={() => setDept(d.code)}>
                  {d.label}
                </button>
              ))}
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 6 }}>
                <input type="checkbox" checked={onlyTodo} onChange={(e) => setOnlyTodo(e.target.checked)} /> 미완료만 보기
              </label>
              <button className="btn" onClick={copyTodo} title="팀장님께 보낼 미완료 명단을 복사합니다">
                {copied ? "✔ 복사됨" : "미완료 명단 복사"}
              </button>
              <button className="btn" onClick={load}>새로고침</button>
            </div>

            <div className="table-wrap">
              <table className="table" data-testid="setup-people">
                <thead>
                  <tr><th>이름</th><th>로그인</th><th>카카오</th><th>알림음</th></tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <b>{p.name}</b>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {p.departmentLabel} · {p.roleName}
                          {p.teamLeader ? " · 팀장" : ""}
                        </div>
                      </td>
                      <td><Cell ok={!!p.lastLoginAt} label={fmt(p.lastLoginAt)} /></td>
                      <td><Cell ok={!!p.kakaoLinkedAt} label={fmt(p.kakaoLinkedAt)} /></td>
                      <td><Cell ok={p.pushDevices > 0} label={p.pushDevices > 1 ? `${p.pushDevices}대` : null} /></td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr><td colSpan={4} className="muted">해당하는 사람이 없습니다{onlyTodo ? " — 모두 완료했습니다 🎉" : ""}.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </>
  );
}
