"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { api, fmtTime, newRequestId, useMe, useStoredState } from "@/lib/client";
import { CALL_ROLES, lineWithProcess, type AndonEvent, type CallSituation, type CallTargetDepartment, type MasterData } from "@/lib/domain";
import { categoryName, departmentLabel, roleName, useLang, useT } from "@/lib/i18n";

type SubmitState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; event: AndonEvent; duplicate: boolean }
  | { kind: "error"; message: string };

// ANDON call by the GAP leader (plant decision 2026-10-06): the GAP leader judges the situation and calls
// one or more departments and, within each, the people who get the message. Login required.
export default function OperatorPage() {
  const { user, loaded } = useMe();
  const lang = useLang();
  const tr = useT();
  const canCall = !!user?.active && CALL_ROLES.includes(user.role);
  const [targets, setTargets] = useState<CallTargetDepartment[] | null>(null);
  const [situationList, setSituationList] = useState<CallSituation[]>([]);
  const [situations, setSituations] = useState<string[]>([]);
  // The GAP leader's own lines (line ownership) come first; all other lines are folded away.
  const [myLines, setMyLines] = useState<string[] | null>(null);
  const [showAllLines, setShowAllLines] = useState(false);
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

  /**
   * The chosen situations decide everything else (plant 2026-10-13: no 세부 설정 — line → situation → CALL):
   * category = the first situation's, departments = their targets with the default people. Calling any
   * department except PC&L also messages UAP (plant meeting 2026-10-07). PC&L 자재 결품 (2026-10-08):
   * 자작품 → PC&L SV + UAP 전체; 외주품 → PC&L 전체 (no UAP).
   */
  function applySituations(next: string[], targets: CallTargetDepartment[] | null) {
    const sits = next.map((c) => situationList.find((s) => s.code === c)).filter((s): s is CallSituation => !!s);
    setCategoryCode(sits[0]?.category ?? "");
    const target = (c: string) => targets?.find((t) => t.code === c);
    const chosen: Record<string, Set<string>> = {};
    const add = (dept: string, ids: (number | string)[] | undefined) => {
      if (!target(dept)) return;
      chosen[dept] ??= new Set();
      for (const id of ids ?? []) chosen[dept].add(String(id));
    };
    const defaults = (dept: string) => target(dept)?.defaultMemberIds ?? target(dept)?.members.map((m) => m.id);
    for (const s of sits) {
      if (s.code === "PCL_SHORTAGE_INHOUSE") {
        add("PCL", target("PCL")?.supervisorIds);
        add("UAP", target("UAP")?.members.map((m) => m.id));
      } else if (s.code === "PCL_SHORTAGE_PURCHASED") {
        add("PCL", target("PCL")?.members.map((m) => m.id));
      } else {
        add(s.target, defaults(s.target));
        if (s.target === "HSE") add("UAP", []); // UAP closes it; the server tells PM, team leaders, the line's 슈퍼
        else if (s.target !== "PCL" && s.target !== "UAP") add("UAP", defaults("UAP"));
      }
    }
    setDeps((targets ?? []).map((t) => t.code).filter((c) => chosen[c]));
    setPeople(Object.fromEntries(Object.entries(chosen).map(([d, ids]) => [d, [...ids]])));
  }
  function toggleSituation(code: string) {
    const next = situations.includes(code) ? situations.filter((c) => c !== code) : [...situations, code];
    setSituations(next);
    applySituations(next, targets);
  }
  // The line's people (슈퍼 / GL) arrive with the targets of that line: a situation tapped before they loaded
  // is applied again, so nobody is missed (there is no screen to add people by hand any more).
  const situationsRef = useRef(situations);
  useEffect(() => {
    situationsRef.current = situations;
  }, [situations]);
  useEffect(() => {
    if (targets && situationsRef.current.length) applySituations(situationsRef.current, targets);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the targets change
  }, [targets]);
  const situationGroups = [...new Set(situationList.map((s) => s.target))].sort((a, b) => Number(b === "MT") - Number(a === "MT")).map((target) => ({
    target,
    label: targets?.find((t) => t.code === target)?.label ?? target,
    items: situationList.filter((s) => s.target === target),
  }));
  // "QC 3명 · MT 1명" — shown in the call bar
  const recipientSummary = deps
    .filter((d) => (people[d]?.length ?? 0) > 0 || d !== "UAP")
    .map((d) => `${targets?.find((t) => t.code === d)?.label.split(" · ")[0] ?? d} ${people[d]?.length ?? 0}${tr("명", "")}`)
    .join(" · ") + (deps.includes("HSE") ? tr(" + 공장장 · 팀장 · 담당 슈퍼", " + plant manager · team leaders · line supervisor") : "");
  const situationText = situationList.filter((s) => situations.includes(s.code)).map((s) => s.nameKo).join(", ");

  const processes = meta?.processes.filter((p) => p.lineCode === lineCode) ?? [];
  // A real line without a process master has exactly one placeholder process: chosen automatically.
  const onlyPlaceholder = processes.length === 1 && processes[0].placeholder;
  const processId = onlyPlaceholder ? String(processes[0].id) : chosenProcessId;
  const validProcess = processes.some((p) => String(p.id) === processId);
  // Lines grouped by UAP area (prototype lines without an area last).
  const lineGroups = meta
    ? [...meta.uapAreas.map((a) => ({ key: a.code, title: a.name })), { key: "", title: tr("시범 라인 (Prototype)", "Prototype lines") }]
        .map((g) => ({ ...g, lines: meta.lines.filter((l) => (l.uapAreaCode ?? "") === g.key) }))
        .filter((g) => g.lines.length > 0)
    : [];

  const mine = (myLines ?? []).map((c) => meta?.lines.find((l) => l.code === c)).filter((l): l is NonNullable<typeof l> => !!l);
  // Plant request 2026-10-13: a UAP SV / GL always starts from their own lines — the other lines stay folded
  // (people without own lines, e.g. the UAP team leader, see every line).
  const allOpen = mine.length === 0 || showAllLines;
  const startChecked = useRef(false);
  useEffect(() => {
    if (startChecked.current || myLines === null || !meta) return;
    startChecked.current = true;
    // a line remembered on this device that is not one of my lines is dropped; exactly one own line is chosen
    if (mine.length > 0 && lineCode && !mine.some((l) => l.code === lineCode)) {
      setLineCode(mine.length === 1 ? mine[0].code : "");
      setProcessId("");
    } else if (!lineCode && mine.length === 1) setLineCode(mine[0].code);
  }, [lineCode, mine, myLines, meta, setLineCode, setProcessId]);
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
      !lineCode && tr("라인", "line"),
      !validProcess && tr("공정", "process"),
      (situations.length === 0 || !categoryCode || deps.length === 0) && tr("상황", "situation"),
    ].filter(Boolean);
    if (missing.length) {
      setValidation(tr(`${missing.join(", ")}을(를) 선택/입력하세요.`, `Please choose: ${missing.join(", ")}.`));
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
    setDeps([]);
    setPeople({});
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
            ✔ {tr("ANDON 호출 완료 (sent)", "ANDON sent")}
            <div style={{ fontSize: 34, fontWeight: 900, margin: "8px 0" }}>{e.id}</div>
            <div style={{ fontWeight: 500, fontSize: 18 }}>
              {lineWithProcess(e.lineName, e.processName)} · {categoryName(lang, e.categoryCode, e.categoryName)} · {tr("조치부서", "Department")}: {departmentLabel(lang, e.departmentLabel)}
              <br />
              {tr("발생시각", "Raised at")} {fmtTime(e.createdAt)} — {tr("현황판에 표시되고 선택한 사람에게 카카오톡 알림이 전송됩니다.", "shown on the dashboard; the chosen people are alerted.")}
              {state.duplicate && <><br />{tr("(이미 접수된 호출입니다 · already registered)", "(already registered)")}</>}
            </div>
          </div>
          <div className="row">
            <button className="btn btn-primary btn-big" onClick={reset}>
              {tr("새 ANDON 호출", "New ANDON call")}
            </button>
            <Link className="btn btn-big" href={`/respond/${encodeURIComponent(e.id)}`}>
              {tr("상세 보기", "View details")}
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
        <h1>{tr("ANDON 호출", "Call ANDON")} <span className="muted" style={{ fontSize: 16 }}>GAP Leader Call</span></h1>

        {!loaded && <p className="muted">{tr("불러오는 중…", "Loading…")}</p>}
        {loaded && !user && (
          <div className="card">
            <p style={{ marginTop: 0 }}>{tr("ANDON 호출은 GAP 리더가 로그인해서 합니다. 작업자는 GAP 리더를 불러 주세요.", "ANDON calls are made by the logged-in GAP leader. Operators call their GAP leader.")}</p>
            <Link className="btn btn-primary" href="/login?next=/operator">{tr("로그인", "Log in")}</Link>
          </div>
        )}
        {loaded && user && !canCall && (
          <div className="alert alert-warn">
            {tr(
              `${user.name} 님 계정(${user.roleName})은 ANDON을 호출할 수 없습니다. 호출은 GAP 리더·슈퍼만 할 수 있습니다. 역할 변경은 관리자에게 요청하세요.`,
              `Your account (${roleName(lang, user.role, user.roleName)}) cannot call ANDON — only GAP leaders and supervisors can. This screen is shown for information.`,
            )}
          </div>
        )}

        {canCall && metaError && (
          <div className="alert alert-error">
            {tr("기준정보를 불러오지 못했습니다", "Could not load the master data")}: {metaError}{" "}
            <button className="btn" onClick={loadMeta}>{tr("다시 시도", "Retry")}</button>
          </div>
        )}
        {canCall && !meta && !metaError && <p className="muted">{tr("불러오는 중…", "Loading…")}</p>}

        {canCall && meta && (
          <>
            <div className="field">
              <span className="field-label">{tr("라인", "Line")}<span className="en">{tr("Line", "")}</span></span>
              {mine.length > 0 && (
                <div className="line-group my-lines" data-testid="my-lines">
                  <div className="line-group-title">{tr("내 담당 라인 · My lines", "My lines")}</div>
                  <div className="choices">{mine.map(lineButton)}</div>
                </div>
              )}
              {mine.length > 0 && (
                <button type="button" className="btn other-lines" aria-expanded={allOpen} onClick={() => setShowAllLines(!allOpen)}>
                  {allOpen ? tr("다른 라인 접기", "Hide other lines") : tr("다른 라인 보기 (전체)", "Show all lines")}
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


            {lineCode && !onlyPlaceholder && (
              <div className="field">
                <span className="field-label">{tr("공정", "Process")}<span className="en">{tr("Process", "")}</span></span>
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
                <span className="field-label">{tr("상황", "Situation")}<span className="en">{tr("Situation · 여러 개 선택 가능 → 호출 부서 자동 선택", "several allowed → departments are chosen automatically")}</span></span>
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

            {targetsError && (
              <div className="alert alert-error">
                {tr("부서·담당자 목록을 불러오지 못했습니다", "Could not load departments and people")}: {targetsError} <button className="btn" onClick={loadTargets}>{tr("다시 시도", "Retry")}</button>
              </div>
            )}

            {/* Optional comment (plant 2026-10-13); 예방보전 needs a short note on the planned work. No photos. */}
            <div className="field">
              <label htmlFor="desc">
                {situations.includes("MT_PREVENTIVE") ? tr("예방보전 안내", "Preventive maintenance note") : tr("내용", "Comment")}
                <span className="en" style={{ fontWeight: 500, color: "var(--ink-3)", fontSize: 14, marginLeft: 6 }}>
                  {situations.includes("MT_PREVENTIVE") ? tr("100자 이내", "max. 100 characters") : tr("선택 · Comment", "optional")}
                </span>
              </label>
              <textarea
                id="desc"
                className="textarea"
                maxLength={situations.includes("MT_PREVENTIVE") ? 100 : 500}
                placeholder={
                  situations.includes("MT_PREVENTIVE")
                    ? tr("예) 3번 로봇 정기 점검, 14:00~16:00 라인 정지", "e.g. robot 3 inspection, line stop 14:00–16:00")
                    : tr("추가 설명 (선택) — 비워두면 선택한 상황이 내용이 됩니다", "Optional — when empty, the chosen situations become the description")
                }
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {validation && <div className="alert alert-warn">{validation}</div>}
            {state.kind === "error" && (
              <div className="alert alert-error" role="alert">
                ✖ {tr("호출 실패 (not sent)", "Not sent")}: {state.message}
                <div style={{ fontWeight: 500, marginTop: 4 }}>
                  {tr("아래 버튼을 다시 누르세요. 같은 호출이 두 번 등록되지 않습니다.", "Press the button again — the same call is never registered twice.")}
                </div>
              </div>
            )}

            {/* Always-visible call bar: the last tap, without scrolling. */}
            <div className="call-bar">
              <div className="call-bar-sum" data-testid="call-summary">
                {ready ? (
                  <>
                    <b>{meta.lines.find((l) => l.code === lineCode)?.name}</b> · {situationText || meta.categories.find((c) => c.code === categoryCode)?.nameKo}
                    <br />→ {recipientSummary || tr("받는 사람 없음", "no recipients")}
                  </>
                ) : (
                  <span className="muted">{!lineCode ? tr("① 라인을 선택하세요", "① Choose the line") : tr("② 상황을 선택하세요", "② Choose the situation")}</span>
                )}
              </div>
              <button className="btn-andon" onClick={submit} disabled={sending || !ready} aria-busy={sending}>
                {sending ? tr("전송 중…", "Sending…") : "ANDON CALL"}
                <small>{sending ? tr("Sending — 잠시 기다리세요", "please wait") : state.kind === "error" ? tr("다시 시도 · Retry", "Retry") : tr("호출하기", "send")}</small>
              </button>
            </div>
          </>
        )}
      </main>
    </>
  );
}
