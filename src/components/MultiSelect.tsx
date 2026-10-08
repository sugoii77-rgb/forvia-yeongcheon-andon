"use client";
// Drop-down with check boxes (several values). Closed: a button with the chosen labels; open: the list
// with "전체 선택 / 해제". Large touch targets for phones.
import { useEffect, useId, useRef, useState } from "react";

export interface MultiOption {
  value: string;
  label: string;
  hint?: string;
}

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  placeholder = "선택하세요",
  emptyText = "선택할 항목이 없습니다",
  testId,
}: {
  label: string;
  options: MultiOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const chosen = options.filter((o) => selected.includes(o.value));
  const summary =
    chosen.length === 0 ? placeholder : chosen.length <= 3 ? chosen.map((o) => o.label).join(", ") : `${chosen.slice(0, 2).map((o) => o.label).join(", ")} 외 ${chosen.length - 2}명`;
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const all = options.length > 0 && chosen.length === options.length;

  return (
    <div className="ms" ref={box} data-testid={testId}>
      <button
        type="button"
        className={`ms-btn${chosen.length ? "" : " ms-empty"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${label}: ${chosen.length ? chosen.map((o) => o.label).join(", ") : placeholder}`}
        onClick={() => setOpen(!open)}
      >
        <span className="ms-sum">{summary}</span>
        {chosen.length > 0 && <span className="ms-count">{chosen.length}</span>}
        <span className="ms-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="ms-panel" id={listId} role="listbox" aria-multiselectable="true" aria-label={label}>
          {options.length === 0 ? (
            <div className="ms-none">{emptyText}</div>
          ) : (
            <>
              <button type="button" className="ms-all" onClick={() => onChange(all ? [] : options.map((o) => o.value))}>
                {all ? "전체 해제" : "전체 선택"}
              </button>
              {options.map((o) => (
                <label key={o.value} className="ms-opt" role="option" aria-selected={selected.includes(o.value)}>
                  <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
                  <span>{o.label}</span>
                  {o.hint && <small>{o.hint}</small>}
                </label>
              ))}
              <button type="button" className="ms-done" onClick={() => setOpen(false)}>완료</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
