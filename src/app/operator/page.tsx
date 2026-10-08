"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { api, fmtTime, newRequestId, useMe, useStoredState } from "@/lib/client";
import { CALL_ROLES, type AndonEvent, type CallSituation, type CallTargetDepartment, type MasterData } from "@/lib/domain";
import { MultiSelect } from "@/components/MultiSelect";

type SubmitState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; event: AndonEvent; duplicate: boolean }
  | { kind: "error"; message: string };

// ANDON call by the GAP leader (plant decision 2026-10-06): the GAP leader judges the situation and calls
// one or more departments and, within each, the people who get the message. Login required.
export default function OperatorPage() {
  const { user, loaded } = useMe();
  const canCall = !!user?.active && CALL_ROLES.includes(user.role);
  const [targets, setTargets] = useState<CallTargetDepartment[] | null>(null);
  const [categoryDefaults, setCategoryDefaults] = useState<Record<string, string>>({});
  const [situationList, setSituationList] = useState<CallSituation[]>([]);
  const [situations, setSituations] = useState<string[]>([]);
  // The GAP leader's own lines (line ownership) come first; all other lines are folded away.
  const [myLines, setMyLines] = useState<string[] | null>(null);
  const [showAllLines, setShowAllLines] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [deps, setDeps] = useState<string[]>([]);
  const [people, setPeople] = useState<Record<string, string[]>>({});
  const [meta, setMeta] = useState<MasterData | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  // Station defaults are remembered per device (tablets are usually fixed to one line).
  const [lineCode, setLineCode] = useStoredState("andon.operator.line", "");
  const [chosenProcessId, setProcessId] = useStoredState("andon.operator.process", "");
  const [categoryCode, setCategoryCode] = useState("");
  const [description, setDescription] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  const [validation, setValidation] = useState<string | null>(null);

  // Idempotency key for this form. Kept across retries so a retry after a timeout
  // cannot create a second ANDON; renewed only after a confirmed success.
  const requestId = useRef(newRequestId());

  const loadMeta = useCallback(() => {
    api<MasterData>("/api/meta").then(
      (m) => {
        setMeta(m);
        setMetaError(null);
      },
      (e: Error) => setMetaError(e.message),
    );
  }, []);
  useEffect(loadMeta, [loadMeta]);
  const loadTargets = useCallback(() => {
    // with the line: the line's supervisor is pre-chosen when SV is called
    api<{ departments: CallTargetDepartment[]; categoryDefaults: Record<string, string>; situations: CallSituation[]; myLines: string[] }>(
      `/api/call-targets${lineCode ? `?line=${encodeURIComponent(lineCode)}` : ""}`,
    ).then(
      (r) => {
        setTargets(r.departments);
        setCategoryDefaults(r.categoryDefaults ?? {});
        setSituationList(r.situations ?? []);
        setMyLines(r.myLines ?? []);
        setTargetsError(null);
      },
      (e: Error) => setTargetsError(e.message),
    );
  }, [lineCode]);
  useEffect(() => {
    if (canCall) loadTargets();
  }, [canCall, loadTargets]);

  /** Departments changed: a newly added department starts with ALL its people chosen (the department rule). */
  function chooseDeps(chosen: string[]) {
    // Plant meeting 2026-10-07: calling any department except PC&L also messages UAP (line SV, line GL,
    // UAP team leader / 책임) — added automatically when such a department is ADDED (removable).
    const added = chosen.filter((d) => !deps.includes(d));
    const order = (targets ?? []).map((t) => t.code);
    const withUap = added.some((d) => d !== "PCL" && d !== "UAP") && !chosen.includes("UAP") && order.includes("UAP") ? [...chosen, "UAP"] : chosen;
    const next = order.filter((c) => withUap.includes(c));
    setDeps(next);
    setPeople((cur) => {
      const out: Record<string, string[]> = {};
      for (const d of next) {
        const t = targets?.find((x) => x.code === d);
        out[d] = cur[d] ?? (t?.defaultMemberIds ?? t?.members.map((m) => m.id) ?? []).map(String);
      }
      return out;
    });
  }
  function chooseCategory(code: string) {
    setCategoryCode(code);
    // Suggest the category's usual department while none is chosen yet; the GAP leader can change it.
    const def = categoryDefaults[code];
    if (deps.length === 0 && def && targets?.some((t) => t.code === def)) chooseDeps([def]);
  }
  /** Situation picked: its call target is added (with its default people) and the category suggested. */
  function toggleSituation(code: string) {
    const on = !situations.includes(code);
    setSituations(on ? [...situations, code] : situations.filter((c) => c !== code));
    if (!on) return;
    if (code === "MT_PREVENTIVE") setMoreOpen(true); // the planned-work text is asked for
    const sit = situationList.find((s) => s.code === code);
    if (!sit) return;
    if (!categoryCode) setCategoryCode(sit.category);
    // PC&L 자재 결품 (plant decision 2026-10-08): 자작품 → PC&L SV + UAP 전체; 외주품 → PC&L 전체 (no UAP)
    if (code === "PCL_SHORTAGE_INHOUSE" || code === "PCL_SHORTAGE_PURCHASED") {
      const pcl = targets?.find((t) => t.code === "PCL");
      const uap = targets?.find((t) => t.code === "UAP");
      const inhouse = code === "PCL_SHORTAGE_INHOUSE";
      const order = (targets ?? []).map((t) => t.code);
      setDeps(order.filter((c) => deps.includes(c) || c === "PCL" || (inhouse && c === "UAP")));
      setPeople((cur) => ({
        ...cur,
        PCL: (inhouse ? (pcl?.supervisorIds ?? []) : (pcl?.members.map((m) => m.id) ?? [])).map(String),
        ...(inhouse ? { UAP: (uap?.members.map((m) => m.id) ?? []).map(String) } : {}),
      }));
      return;
    }
    if (!deps.includes(sit.target) && targets?.some((t) => t.code === sit.target)) {
      chooseDeps((targets ?? []).map((t) => t.code).filter((c) => c === sit.target || deps.includes(c)));
    }
  }
  const situationGroups = [...new Set(situationList.map((s) => s.target))].map((target) => ({
    target,
    label: targets?.find((t) => t.code === target)?.label ?? target,
    items: situationList.filter((s) => s.target === target),
  }));
  const recipientCount = deps.reduce((n, d) => n + (people[d]?.length ?? 0), 0);
  // "QC 3명 · MT 1명" — shown in the call bar and on the folded details
  const recipientSummary = deps
    .map((d) => `${targets?.find((t) => t.code === d)?.label.split(" · ")[0] ?? d} ${people[d]?.length ?? 0}명`)
    .join(" · ");
  const situationText = situationList.filter((s) => situations.includes(s.code)).map((s) => s.nameKo).join(", ");

  const processes = meta?.processes.filter((p) => p.lineCode === lineCode) ?? [];
  // A real line without a process master has exactly one placeholder process: chosen automatically.
  const onlyPlaceholder = processes.length === 1 && processes[0].placeholder;
  const processId = onlyPlaceholder ? String(processes[0].id) : chosenProcessId;
  const validProcess = processes.some((p) => String(p.id) === processId);
  // Lines grouped by UAP area (prototype lines without an area last).
  const lineGroups = meta
    ? [...meta.uapAreas.map((a) => ({ key: a.code, title: a.name })), { key: "", title: "시범 라인 (Prototype)" }]
        .map((g) => ({ ...g, lines: meta.lines.filter((l) => (l.uapAreaCode ?? "") === g.key) }))
        .filter((g) => g.lines.length > 0)
    : [];

  const mine = (myLines ?? []).map((c) => meta?.lines.find((l) => l.code === c)).filter((l): l is NonNullable<typeof l> => !!l);
  // a remembered line outside "my lines" keeps the full list open, so the choice stays visible
  const allOpen = mine.length === 0 || showAllLines || (!!lineCode && !mine.some((l) => l.code === lineCode));
  useEffect(() => {
    // exactly one own line and nothing chosen yet: choose it
    if (!lineCode && mine.length === 1) setLineCode(mine[0].code);
  }, [lineCode, mine, setLineCode]);
  const lineButton = (l: { code: string; name: string }) => (
    <button
      key={l.code}
      type="button"
      className="choice"
      aria-pressed={lineCode === l.code}
      onClick={() => {
        setLineCode(l.code);
        setProcessId("");
      }}
    >
      {l.name}
    </button>
  );

  // everything the call needs — normally after 2–3 taps (line, situation)
  const ready = !!lineCode && validProcess && !!categoryCode && deps.length > 0 && (situations.length > 0 || !!description.trim());

  async function submit() {
    if (state.kind === "sending") return; // guard against double taps
    const missing = [
      !lineCode && "라인",
      !validProcess && "공정",
      !categoryCode && "이상 유형",
      deps.length === 0 && "조치부서",
      !description.trim() && situations.length === 0 && "상황 또는 이상 내용",
    ].filter(Boolean);
    if (missing.length) {
      setValidation(`${missing.join(", ")}을(를) 선택/입력하세요.`);
      return;
    }
    setValidation(null);
    setState({ kind: "sending" });

    const form = new FormData();
    form.set("lineCode", lineCode);
    form.set("processId", processId);
    form.set("categoryCode", categoryCode);
    // the description may be left empty when situations were picked: their names are used
    const sitText = situationList.filter((s) => situations.includes(s.code)).map((s) => s.nameKo).join(", ");
    form.set("description", description.trim() ? (sitText ? `[${sitText}] ${description.trim()}` : description.trim()) : sitText);
    for (const s of situations) form.append("situations", s);
    for (const d of deps) form.append("departments", d);
    for (const d of deps) for (const id of people[d] ?? []) form.append("recipients", id);
    form.set("clientRequestId", requestId.current);

    try {
      const res = await api<{ event: AndonEvent; duplicate: boolean }>(
        "/api/andons",
        { method: "POST", body: form },
        20000,
      );
      setState({
        kind: "ok",
        event: res.event,
        duplicate: res.duplicate,
      });
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    }
  }

  function reset() {
    requestId.current = newRequestId();
    setCategoryCode("");
    setSituations([]);
    chooseDeps([]);
    setDescription("");
    setState({ kind: "idle" });
  }

  if (state.kind === "ok") {
    const e = state.event;
    return (
      <>
        <TopBar />
        <main className="page">
          <div className="alert alert-ok" role="status" style={{ fontSize: 22, padding: 24 }}>
            ✔ ANDON 호출 완료 (sent)
            <div style={{ fontSize: 34, fontWeight: 900, margin: "8px 0" }}>{e.id}</div>
            <div style={{ fontWeight: 500, fontSize: 18 }}>
              {e.lineName} / {e.processName} · {e.categoryName} · 조치부서: {e.departmentLabel}
              <br />
              발생시각 {fmtTime(e.createdAt)} — 현황판에 표시되고 선택한 사람에게 카카오톡 알림이 전송됩니다.
              {state.duplicate && <><br />(이미 접수된 호출입니다 · already registered)</>}
            </div>
          </div>
          <div className="row">
            <button className="btn btn-primary btn-big" onClick={reset}>
              새 ANDON 호출
            </button>
            <Link className="btn btn-big" href={`/respond/${encodeURIComponent(e.id)}`}>
              상세 보기
            </Link>
          </div>
        </main>
      </>
    );
  }

  const sending = state.kind === "sending";

  return (
    <>
      <TopBar />
      <main className="page">
        <h1>ANDON 호출 <span className="muted" style={{ fontSize: 16 }}>GAP Leader Call</span></h1>

        {!loaded && <p className="muted">불러오는 중…</p>}
        {loaded && !user && (
          <div className="card">
            <p style={{ marginTop: 0 }}>ANDON 호출은 <strong>GAP 리더</strong>가 로그인해서 합니다. 작업자는 GAP 리더를 불러 주세요.</p>
            <Link className="btn btn-primary" href="/login?next=/operator">로그인</Link>
          </div>
        )}
        {loaded && user && !canCall && (
          <div className="alert alert-warn">
            {user.name} 님 계정({user.roleName})은 ANDON을 호출할 수 없습니다. 호출은 GAP 리더·감독자만 할 수 있습니다.
            역할 변경은 관리자에게 요청하세요.
          </div>
        )}

        {canCall && metaError && (
          <div className="alert alert-error">
            기준정보를 불러오지 못했습니다: {metaError}{" "}
            <button className="btn" onClick={loadMeta}>다시 시도</button>
          </div>
        )}
        {canCall && !meta && !metaError && <p className="muted">불러오는 중…</p>}

        {canCall && meta && (
          <>
            <div className="field">
              <span className="field-label">라인<span className="en">Line</span></span>
              {mine.length > 0 && (
                <div className="line-group my-lines" data-testid="my-lines">
                  <div className="line-group-title">내 담당 라인 · My lines</div>
                  <div className="choices">{mine.map(lineButton)}</div>
                </div>
              )}
              {mine.length > 0 && (
                <button type="button" className="btn other-lines" aria-expanded={allOpen} onClick={() => setShowAllLines(!allOpen)}>
                  {allOpen ? "다른 라인 접기" : "다른 라인 보기 (전체)"}
                </button>
              )}
              {allOpen &&
                lineGroups.map((g) => {
                  const lines = g.lines.filter((l) => !mine.some((m) => m.code === l.code));
                  if (lines.length === 0) return null;
                  return (
                    <div key={g.key || "prototype"} className="line-group">
                      {lineGroups.length > 1 && <div className="line-group-title">{g.title}</div>}
                      <div className="choices">{lines.map(lineButton)}</div>
                    </div>
                  );
                })}
            </div>

            {lineCode && onlyPlaceholder && (
              <div className="field">
                <span className="field-label">공정<span className="en">Process</span></span>
                <p className="muted" style={{ margin: 0 }}>{processes[0].name} — 이 라인의 공정 기준정보는 준비 중입니다.</p>
              </div>
            )}

            {lineCode && !onlyPlaceholder && (
              <div className="field">
                <span className="field-label">공정<span className="en">Process</span></span>
                <div className="choices">
                  {processes.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="choice"
                      aria-pressed={processId === String(p.id)}
                      onClick={() => setProcessId(String(p.id))}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {situationGroups.length > 0 && (
              <div className="field">
                <span className="field-label">상황<span className="en">Situation · 여러 개 선택 가능 → 호출 부서 자동 선택</span></span>
                {situationGroups.map((g) => (
                  <div key={g.target} className="line-group">
                    <div className="line-group-title">{g.label}</div>
                    <div className="choices sit-choices">
                      {g.items.map((s) => (
                        <button key={s.code} type="button" className="choice" aria-pressed={situations.includes(s.code)} onClick={() => toggleSituation(s.code)}>
                          {s.nameKo}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Everything below is filled in by the situation: folded away so the GL needs only 2–3 taps
                (line → situation → ANDON CALL). Open it to change category, departments, people or add text. No photos (plant decision 2026-10-08). */}
            <details className="call-more" open={moreOpen} onToggle={(e) => setMoreOpen((e.target as HTMLDetailsElement).open)}>
              <summary>
                <span className="call-more-t">세부 설정 <span className="muted">(선택)</span></span>
                <span className="call-more-sum">
                  {[meta.categories.find((c) => c.code === categoryCode)?.nameKo, recipientSummary || null, description.trim() ? "내용 입력됨" : null]
                    .filter(Boolean)
                    .join(" · ") || "이상 유형 · 조치부서 · 받는 사람 · 내용"}
                </span>
              </summary>

            <div className="field">
              <span className="field-label">이상 유형<span className="en">Issue category</span></span>
              <div className="choices">
                {meta.categories.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    className="choice"
                    aria-pressed={categoryCode === c.code}
                    onClick={() => chooseCategory(c.code)}
                  >
                    {c.nameKo}
                    <small>{c.nameEn}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span className="field-label">조치부서<span className="en">Departments · 여러 개 선택 가능</span></span>
              {targetsError && (
                <div className="alert alert-error">
                  부서·담당자 목록을 불러오지 못했습니다: {targetsError} <button className="btn" onClick={loadTargets}>다시 시도</button>
                </div>
              )}
              <MultiSelect
                label="조치부서"
                testId="call-departments"
                placeholder="조치부서 선택"
                options={(targets ?? []).map((t) => ({ value: t.code, label: t.label, hint: `${t.members.length}명` }))}
                selected={deps}
                onChange={(v) => chooseDeps((targets ?? []).map((t) => t.code).filter((c) => v.includes(c)))}
              />
            </div>

            {deps.length > 0 && (
              <div className="field">
                <span className="field-label">받는 사람<span className="en">Recipients · 부서별 여러 명 선택</span></span>
                {deps.map((d) => {
                  const t = targets?.find((x) => x.code === d);
                  return (
                    <div key={d} className="call-dept">
                      <div className="call-dept-title">
                        <span>{t?.label ?? d}</span>
                        <span className="muted">{people[d]?.length ?? 0} / {t?.members.length ?? 0}명</span>
                      </div>
                      <MultiSelect
                        label={`${t?.label ?? d} 받는 사람`}
                        testId={`call-people-${d}`}
                        placeholder="받는 사람 선택"
                        emptyText="이 부서에 가입한 담당자가 아직 없습니다"
                        options={(t?.members ?? []).map((m) => ({ value: String(m.id), label: m.name, hint: m.roleName }))}
                        selected={people[d] ?? []}
                        onChange={(v) => setPeople({ ...people, [d]: v })}
                      />
                    </div>
                  );
                })}
                {recipientCount === 0 && (
                  <div className="alert alert-warn" style={{ marginTop: 8 }}>
                    선택한 사람이 없습니다. 호출은 등록되지만 카카오톡 메시지는 아무에게도 가지 않습니다.
                  </div>
                )}
              </div>
            )}

            <div className="field">
              <label htmlFor="desc">
                이상 내용<span className="en" style={{ fontWeight: 500, color: "var(--ink-3)", fontSize: 14, marginLeft: 6 }}>Description</span>
              </label>
              <textarea
                id="desc"
                className="textarea"
                maxLength={situations.includes("MT_PREVENTIVE") ? 100 : 500}
                placeholder={
                  situations.includes("MT_PREVENTIVE")
                    ? "예방보전 안내 (100자 이내) — 예) 3번 로봇 정기 점검, 14:00~16:00 라인 정지"
                    : situations.length
                      ? "추가 설명 (선택) — 비워두면 선택한 상황이 내용이 됩니다"
                      : "예) Stay Bracket 체결 이상 발견"
                }
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            </details>

            {validation && <div className="alert alert-warn">{validation}</div>}
            {state.kind === "error" && (
              <div className="alert alert-error" role="alert">
                ✖ 호출 실패 (not sent): {state.message}
                <div style={{ fontWeight: 500, marginTop: 4 }}>
                  아래 버튼을 다시 누르세요. 같은 호출이 두 번 등록되지 않습니다.
                </div>
              </div>
            )}

            {/* Always-visible call bar: the last tap, without scrolling. */}
            <div className="call-bar">
              <div className="call-bar-sum" data-testid="call-summary">
                {ready ? (
                  <>
                    <b>{meta.lines.find((l) => l.code === lineCode)?.name}</b> · {situationText || meta.categories.find((c) => c.code === categoryCode)?.nameKo}
                    <br />→ {recipientSummary || "받는 사람 없음"}
                  </>
                ) : (
                  <span className="muted">{!lineCode ? "① 라인을 선택하세요" : "② 상황을 선택하세요"}</span>
                )}
              </div>
              <button className="btn-andon" onClick={submit} disabled={sending || !ready} aria-busy={sending}>
                {sending ? "전송 중…" : "ANDON CALL"}
                <small>{sending ? "Sending — 잠시 기다리세요" : state.kind === "error" ? "다시 시도 · Retry" : "호출하기"}</small>
              </button>
            </div>
          </>
        )}
      </main>
    </>
  );
}
