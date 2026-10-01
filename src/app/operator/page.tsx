"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { api, fmtTime, newRequestId, useStoredState } from "@/lib/client";
import type { AndonEvent, MasterData } from "@/lib/domain";

type SubmitState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; event: AndonEvent; duplicate: boolean }
  | { kind: "error"; message: string };

export default function OperatorPage() {
  const [meta, setMeta] = useState<MasterData | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  // Station defaults are remembered per device (tablets are usually fixed to one line).
  const [lineCode, setLineCode] = useStoredState("andon.operator.line", "");
  const [processId, setProcessId] = useStoredState("andon.operator.process", "");
  const [operator, setOperator] = useStoredState("andon.operator.name", "");
  const [categoryCode, setCategoryCode] = useState("");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  const [validation, setValidation] = useState<string | null>(null);

  // Idempotency key for this form. Kept across retries so a retry after a timeout
  // cannot create a second ANDON; renewed only after a confirmed success.
  const requestId = useRef(newRequestId());
  const fileInput = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    return () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    };
  }, [photoUrl]);

  const processes = meta?.processes.filter((p) => p.lineCode === lineCode) ?? [];
  const validProcess = processes.some((p) => String(p.id) === processId);

  async function submit() {
    if (state.kind === "sending") return; // guard against double taps
    const missing = [
      !lineCode && "라인",
      !validProcess && "공정",
      !categoryCode && "이상 유형",
      !description.trim() && "이상 내용",
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
    form.set("description", description.trim());
    form.set("createdBy", operator.trim());
    form.set("clientRequestId", requestId.current);
    if (photo) form.set("photo", photo);

    try {
      const res = await api<{ event: AndonEvent; duplicate: boolean }>(
        "/api/andons",
        { method: "POST", body: form },
        20000,
      );
      setState({ kind: "ok", event: res.event, duplicate: res.duplicate });
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    }
  }

  function reset() {
    requestId.current = newRequestId();
    setCategoryCode("");
    setDescription("");
    setPhoto(null);
    if (fileInput.current) fileInput.current.value = "";
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
              {e.lineName} / {e.processName} · {e.categoryName} · 담당: {e.departmentName}
              <br />
              발생시각 {fmtTime(e.createdAt)} — 현황판에 표시되고 담당자에게 알림이 전송됩니다.
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
        <h1>ANDON 호출 <span className="muted" style={{ fontSize: 16 }}>Operator Call</span></h1>

        {metaError && (
          <div className="alert alert-error">
            기준정보를 불러오지 못했습니다: {metaError}{" "}
            <button className="btn" onClick={loadMeta}>다시 시도</button>
          </div>
        )}
        {!meta && !metaError && <p className="muted">불러오는 중…</p>}

        {meta && (
          <>
            <div className="field">
              <span className="field-label">라인<span className="en">Line</span></span>
              <div className="choices">
                {meta.lines.map((l) => (
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
                ))}
              </div>
            </div>

            {lineCode && (
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

            <div className="field">
              <span className="field-label">이상 유형<span className="en">Issue category</span></span>
              <div className="choices">
                {meta.categories.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    className="choice"
                    aria-pressed={categoryCode === c.code}
                    onClick={() => setCategoryCode(c.code)}
                  >
                    {c.nameKo}
                    <small>{c.nameEn}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label htmlFor="desc">
                이상 내용<span className="en" style={{ fontWeight: 500, color: "var(--ink-3)", fontSize: 14, marginLeft: 6 }}>Description</span>
              </label>
              <textarea
                id="desc"
                className="textarea"
                maxLength={500}
                placeholder="예) Stay Bracket 체결 이상 발견"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="field">
              <span className="field-label">사진<span className="en">Photo (선택)</span></span>
              <div className="row">
                <label className="btn">
                  📷 사진 촬영/선택
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                  />
                </label>
                {photo && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setPhoto(null);
                      if (fileInput.current) fileInput.current.value = "";
                    }}
                  >
                    사진 삭제
                  </button>
                )}
              </div>
              {photoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoUrl} alt="첨부 사진 미리보기" style={{ marginTop: 10, maxWidth: "100%", maxHeight: 240, borderRadius: 10 }} />
              )}
            </div>

            <div className="field">
              <label htmlFor="op">작업자<span className="en" style={{ fontWeight: 500, color: "var(--ink-3)", fontSize: 14, marginLeft: 6 }}>Operator (선택)</span></label>
              <input
                id="op"
                className="input"
                maxLength={40}
                placeholder="이름 또는 사번"
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
              />
            </div>

            {validation && <div className="alert alert-warn">{validation}</div>}
            {state.kind === "error" && (
              <div className="alert alert-error" role="alert">
                ✖ 호출 실패 (not sent): {state.message}
                <div style={{ fontWeight: 500, marginTop: 4 }}>
                  아래 버튼을 다시 누르세요. 같은 호출이 두 번 등록되지 않습니다.
                </div>
              </div>
            )}

            <button className="btn-andon" onClick={submit} disabled={sending} aria-busy={sending}>
              {sending ? "전송 중…" : "ANDON CALL"}
              <small>{sending ? "Sending — 잠시 기다리세요" : state.kind === "error" ? "다시 시도 · Retry" : "호출하기"}</small>
            </button>
          </>
        )}
      </main>
    </>
  );
}
