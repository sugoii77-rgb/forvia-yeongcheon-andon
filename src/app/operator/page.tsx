"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { api, fmtTime, newRequestId, useStoredState } from "@/lib/client";
import { preparePhoto } from "@/lib/photoPrep";
import type { AndonEvent, MasterData } from "@/lib/domain";

type SubmitState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; event: AndonEvent; duplicate: boolean; photoWarning: string | null }
  | { kind: "error"; message: string };

export default function OperatorPage() {
  const [meta, setMeta] = useState<MasterData | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  // Station defaults are remembered per device (tablets are usually fixed to one line).
  const [lineCode, setLineCode] = useStoredState("andon.operator.line", "");
  const [chosenProcessId, setProcessId] = useStoredState("andon.operator.process", "");
  const [operator, setOperator] = useStoredState("andon.operator.name", "");
  const [categoryCode, setCategoryCode] = useState("");
  const [description, setDescription] = useState("");
  // `photo` is the already-resized JPEG. Resizing starts as soon as a photo is picked.
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const pendingPhoto = useRef<Promise<File | null> | null>(null);
  const photoToken = useRef(0);
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

  function pickPhoto(file: File | null) {
    const token = ++photoToken.current;
    setPhoto(null);
    setPhotoNote(null);
    if (!file) {
      pendingPhoto.current = null;
      setPhotoBusy(false);
      return;
    }
    setPhotoBusy(true);
    const job = preparePhoto(file).then(
      (prepared) => {
        if (token === photoToken.current) setPhoto(prepared);
        return prepared;
      },
      (err) => {
        console.warn("photo could not be prepared", err);
        if (token === photoToken.current) {
          setPhotoNote("이 사진은 사용할 수 없습니다 (형식 미지원). 사진 없이 호출할 수 있습니다.");
          if (fileInput.current) fileInput.current.value = "";
        }
        return null;
      },
    );
    pendingPhoto.current = job;
    job.finally(() => {
      if (token === photoToken.current) {
        setPhotoBusy(false);
        pendingPhoto.current = null;
      }
    });
  }

  function clearPhoto() {
    pickPhoto(null);
    if (fileInput.current) fileInput.current.value = "";
  }

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

    // Never let photo processing delay the call for long: wait at most 5 s, then send without it.
    let photoToSend = photo;
    let localPhotoNote: string | null = null;
    if (pendingPhoto.current) {
      photoToSend = await Promise.race([
        pendingPhoto.current,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (!photoToSend) localPhotoNote = "사진 처리가 지연되어 사진 없이 호출했습니다.";
    }

    const form = new FormData();
    form.set("lineCode", lineCode);
    form.set("processId", processId);
    form.set("categoryCode", categoryCode);
    form.set("description", description.trim());
    form.set("createdBy", operator.trim());
    form.set("clientRequestId", requestId.current);
    if (photoToSend) form.set("photo", photoToSend);

    try {
      const res = await api<{ event: AndonEvent; duplicate: boolean; photoWarning?: string | null }>(
        "/api/andons",
        { method: "POST", body: form },
        20000,
      );
      setState({
        kind: "ok",
        event: res.event,
        duplicate: res.duplicate,
        photoWarning: res.photoWarning ?? localPhotoNote,
      });
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    }
  }

  function reset() {
    requestId.current = newRequestId();
    setCategoryCode("");
    setDescription("");
    clearPhoto();
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
              {e.lineName} / {e.processName} · {e.categoryName} · 담당: {e.departmentLabel}
              <br />
              발생시각 {fmtTime(e.createdAt)} — 현황판에 표시되고 담당자에게 알림이 전송됩니다.
              {state.duplicate && <><br />(이미 접수된 호출입니다 · already registered)</>}
            </div>
          </div>
          {state.photoWarning && (
            <div className="alert alert-warn" role="status">
              ⚠ 사진은 첨부되지 않았습니다 (photo not attached): {state.photoWarning}
            </div>
          )}
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
              {lineGroups.map((g) => (
                <div key={g.key || "prototype"} className="line-group">
                  {lineGroups.length > 1 && <div className="line-group-title">{g.title}</div>}
                  <div className="choices">
                    {g.lines.map((l) => (
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
              ))}
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
                    onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)}
                  />
                </label>
                {(photo || photoBusy) && (
                  <button type="button" className="btn" onClick={clearPhoto}>
                    사진 삭제
                  </button>
                )}
                {photoBusy && <span className="muted">사진 처리 중…</span>}
              </div>
              {photoNote && <div className="alert alert-warn">{photoNote}</div>}
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
