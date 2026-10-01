"use client";
import type { MasterData } from "@/lib/domain";

/** Phase 1 has no login: the responder picks their name once per device (stored in localStorage). */
export function ResponderPicker({
  meta,
  value,
  onChange,
}: {
  meta: MasterData;
  value: string;
  onChange: (name: string) => void;
}) {
  const dept = (code: string) => meta.departments.find((d) => d.code === code)?.nameKo ?? code;
  return (
    <div className="field">
      <label htmlFor="responder">
        담당자 <span className="muted" style={{ fontWeight: 500, fontSize: 14 }}>Responder</span>
      </label>
      <select id="responder" className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— 이름 선택 —</option>
        {meta.users.map((u) => (
          <option key={u.id} value={u.name}>
            {u.name} ({dept(u.departmentCode)})
          </option>
        ))}
      </select>
    </div>
  );
}
