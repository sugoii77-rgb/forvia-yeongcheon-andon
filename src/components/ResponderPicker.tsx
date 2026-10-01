"use client";
import type { MasterData, ResponderSummary } from "@/lib/domain";

/**
 * Phase 1 has no login: the responder picks their name once per device (stored in localStorage).
 * The server validates the choice on every ACK / ACTION / CLOSE. `options` comes from the server
 * (eligible responders of an event, or all responder-capable users) — no routing logic here.
 */
export function ResponderPicker({
  meta,
  options,
  value,
  onChange,
}: {
  meta: MasterData;
  options: ResponderSummary[];
  value: string;
  onChange: (userId: string) => void;
}) {
  const dept = (code: string) => meta.departments.find((d) => d.code === code)?.nameKo ?? code;
  const role = (code: string) => meta.roles.find((r) => r.code === code)?.nameKo ?? code;
  return (
    <div className="field">
      <label htmlFor="responder">
        담당자 <span className="muted" style={{ fontWeight: 500, fontSize: 14 }}>Responder</span>
      </label>
      <select id="responder" className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— 이름 선택 —</option>
        {options.map((u) => (
          <option key={u.id} value={String(u.id)}>
            {u.name} ({dept(u.departmentCode)} · {role(u.role)})
          </option>
        ))}
      </select>
    </div>
  );
}

/** All active users whose role may respond (for the inbox, before an event is chosen). */
export function responderCapableUsers(meta: MasterData): ResponderSummary[] {
  const canRespond = new Set(meta.roles.filter((r) => r.canRespond).map((r) => r.code));
  return meta.users.filter((u) => canRespond.has(u.role));
}
