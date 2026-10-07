// 2-hour escalation (plant meeting 2026-10-07): an ANDON not COMPLETED 2 hours after the call → one
// separate KakaoTalk message to the plant manager (role PLANT_MANAGER) and the team leaders
// (app_user.team_leader) of PC&L, QC, MT and UAP. Preventive maintenance is excluded.
// Only GAP-leader calls (v9: andon_event_department rows) escalate — older / demo events never do.
// Exactly once per event (andon_escalation primary key, append-only), also with several server instances.
import type { AndonEvent } from "../domain.ts";
import { getEvent } from "./andonService.ts";
import { db, nowIso } from "./db.ts";
import { sendToRecipients, type NotificationRecipient } from "./notifications/index.ts";

export const ESCALATION_AFTER_MS = 2 * 3600_000;
export const ESCALATION_DEPARTMENTS = ["PCL", "QC", "MT", "UAP"] as const;
/** Situations that never escalate (예방보전 — preventive maintenance, when it is added as a situation). */
export const NO_ESCALATION_SITUATIONS = ["MT_PREVENTIVE"];

export async function escalationRecipients(): Promise<NotificationRecipient[]> {
  const rows = await db.all(
    `SELECT u.id, u.name, u.department_code,
            (SELECT c.recipient_id FROM user_notification_channel c
             WHERE c.user_id = u.id AND c.provider = 'KAKAO' AND c.verified = 1 AND c.active = 1 ORDER BY c.id LIMIT 1) AS kakao
     FROM app_user u
     WHERE u.active = 1 AND (u.role = 'PLANT_MANAGER' OR (u.team_leader = 1 AND u.department_code IN (${ESCALATION_DEPARTMENTS.map(() => "?").join(",")})))
     ORDER BY u.id`,
    ...ESCALATION_DEPARTMENTS,
  );
  return rows.map((r) => ({ userId: r.id as number, name: r.name as string, departmentCode: r.department_code as string, address: (r.kakao as string | null) ?? null }));
}

function escalationMessage(e: AndonEvent, nowMs: number) {
  const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  const min = Math.floor((nowMs - new Date(e.createdAt).getTime()) / 60_000);
  const state = e.status === "OPEN" ? "미접수" : "조치 중";
  return {
    title: `[ANDON 에스컬레이션] 2시간 미완료 · ${e.lineName}`,
    body: `${e.id} · ${e.categoryName} · ${state} · 경과 ${Math.floor(min / 60)}시간 ${min % 60}분 · 조치부서 ${e.departmentLabel}`,
    link: `${base}/respond/${encodeURIComponent(e.id)}`,
  };
}

/** Escalates every due event once. Returns the escalated event ids. Never throws. */
export async function runEscalations(nowMs: number = Date.now()): Promise<string[]> {
  const done: string[] = [];
  try {
    const due = await db.all(
      `SELECT e.id, e.situations FROM andon_event e
       WHERE e.status <> 'CLOSED' AND e.created_at <= ?
         AND EXISTS (SELECT 1 FROM andon_event_department x WHERE x.event_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM andon_escalation s WHERE s.event_id = e.id)
       ORDER BY e.created_at LIMIT 50`,
      new Date(nowMs - ESCALATION_AFTER_MS).toISOString(),
    );
    if (due.length === 0) return done;
    const recipients = await escalationRecipients();
    for (const row of due) {
      const sits = (() => {
        try {
          return JSON.parse((row.situations as string) || "[]") as string[];
        } catch {
          return [];
        }
      })();
      if (sits.some((s) => NO_ESCALATION_SITUATIONS.includes(s))) continue;
      // claim first: only one instance sends
      const claim = await db.run("INSERT OR IGNORE INTO andon_escalation (event_id, escalated_at, recipients) VALUES (?, ?, ?)", row.id as string, nowIso(), recipients.length);
      if (claim.changes !== 1) continue;
      const e = await getEvent(row.id as string);
      if (!e) continue;
      await sendToRecipients(e.id, recipients, escalationMessage(e, nowMs));
      console.info(`[escalation] ${e.id} escalated to ${recipients.length} recipient(s)`);
      done.push(e.id);
    }
  } catch (err) {
    console.error("[escalation] run failed", err);
  }
  return done;
}

let lastRun = 0;
/** Cheap trigger for frequently called endpoints (shop-floor board polling): at most once a minute per instance. */
export async function maybeRunEscalations(): Promise<void> {
  const every = Number(process.env.ESCALATION_CHECK_INTERVAL_MS ?? 60_000);
  if (Date.now() - lastRun < every) return;
  lastRun = Date.now();
  await runEscalations();
}
