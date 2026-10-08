// Notification layer. ANDON business logic only calls `notifyAndonCreated(event)`.
// Providers: "mock" (log only) and "kakao" (KakaoTalk "send to me" — each employee links their own
// Kakao account on /me; see ../kakaoNotify.ts). Selected by NOTIFICATION_PROVIDER. Phone push (../webPush.ts)
// is sent alongside, to every device the recipient turned on in /me (KakaoTalk "send to me" has no sound).
import type { AndonEvent } from "../../domain.ts";
import { db, nowIso } from "../db.ts";
import { sendKakaoMemoTo } from "../kakaoNotify.ts";
import { primaryRecipients } from "../routingService.ts";
import { sendPushTo } from "../webPush.ts";

export interface NotificationRecipient {
  userId: number;
  name: string;
  departmentCode: string;
  /** Provider-specific address (e.g. Kakao user id). Null for the mock provider. */
  address: string | null;
}

export interface NotificationMessage {
  title: string;
  body: string;
  link: string;
}

export interface NotificationProvider {
  readonly name: string;
  /** Throw on failure; the caller logs the error. */
  send(recipient: NotificationRecipient, message: NotificationMessage): Promise<void>;
}

class MockNotificationProvider implements NotificationProvider {
  readonly name = "mock";
  async send(recipient: NotificationRecipient, message: NotificationMessage) {
    console.info(`[notify:mock] → ${recipient.name} (${recipient.departmentCode}) | ${message.title} | ${message.link}`);
  }
}

/** KakaoTalk memo ("나에게 보내기") into the recipient's own chat. Needs a verified KAKAO channel. */
class KakaoMemoProvider implements NotificationProvider {
  readonly name = "kakao";
  async send(recipient: NotificationRecipient, message: NotificationMessage) {
    if (!recipient.address) throw new Error("카카오 알림 미연결 (KAKAO_NOT_LINKED)");
    await sendKakaoMemoTo(recipient.userId, kakaoText(message), message.link);
  }
}

/** ≤ 200 characters (Kakao text template limit); the link is always kept in full. */
export function kakaoText(m: NotificationMessage): string {
  const room = 200 - m.link.length - 2;
  let head = `${m.title}
${m.body}`;
  if (head.length > room) head = head.slice(0, Math.max(0, room - 1)) + "…";
  return `${head}
${m.link}`;
}

function createProvider(): NotificationProvider {
  const name = process.env.NOTIFICATION_PROVIDER || "mock";
  switch (name) {
    case "mock":
      return new MockNotificationProvider();
    case "kakao":
      return new KakaoMemoProvider();
    default:
      console.warn(`[notify] unknown NOTIFICATION_PROVIDER "${name}", falling back to mock`);
      return new MockNotificationProvider();
  }
}

let provider: NotificationProvider | null = null;
function getProvider() {
  return (provider ??= createProvider());
}

export function buildAndonMessage(event: AndonEvent): NotificationMessage {
  const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  return {
    title: `[ANDON 발생] ${event.lineName} / ${event.processName}`,
    body: `${event.id} · ${event.categoryName} · ${event.description}`,
    link: `${base}/respond/${encodeURIComponent(event.id)}`,
  };
}

/**
 * Recipients of a new ANDON: the people the GAP leader chose at the call (v9 andon_call_recipient), or —
 * for events created without a choice (server-internal callers) — the department rule
 * (routingService.primaryRecipients). Escalation roles are notified later, when escalation exists.
 * The KakaoTalk address comes ONLY from a verified, active user_notification_channel row.
 */
async function resolveRecipients(event: AndonEvent): Promise<NotificationRecipient[]> {
  const chosen = await db.all(
    `SELECT u.id, u.name, x.department_code,
            (SELECT c.recipient_id FROM user_notification_channel c
             WHERE c.user_id = u.id AND c.provider = 'KAKAO' AND c.verified = 1 AND c.active = 1
             ORDER BY c.id LIMIT 1) AS kakao_recipient_id
     FROM andon_call_recipient x JOIN app_user u ON u.id = x.user_id
     WHERE x.event_id = ? AND u.active = 1 ORDER BY u.id`,
    event.id,
  );
  if (chosen.length > 0 || (await db.get("SELECT 1 FROM andon_event_department WHERE event_id = ?", event.id))) {
    return chosen.map((u) => ({
      userId: u.id as number,
      name: u.name as string,
      departmentCode: u.department_code as string,
      address: (u.kakao_recipient_id as string | null) ?? null,
    }));
  }
  return (await primaryRecipients(event.departmentCode)).map((u) => ({
    userId: u.id,
    name: u.name,
    departmentCode: u.departmentCode,
    address: u.kakaoRecipientId,
  }));
}

async function logAttempt(
  eventId: string,
  provider: string,
  recipient: string,
  status: "SENT" | "FAILED",
  text: string,
  error: string | null,
) {
  try {
    await db.run(
      `INSERT INTO notification_log (event_id, provider, recipient, status, message, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      provider,
      recipient,
      status,
      text,
      error,
      nowIso(),
    );
  } catch (err) {
    console.error("[notify] could not write notification_log", err);
  }
}

/**
 * Sends notifications for a new ANDON and logs every attempt.
 * Never throws: a notification failure must not fail ANDON creation. The route calls it via after()
 * so that it completes after the response, also on serverless platforms (Vercel).
 */
export async function notifyAndonCreated(event: AndonEvent): Promise<void> {
  try {
    const p = getProvider();
    const message = buildAndonMessage(event);
    const text = `${message.title}\n${message.body}\n${message.link}`;

    let recipients: NotificationRecipient[] = [];
    try {
      recipients = await resolveRecipients(event);
    } catch (err) {
      console.error("[notify] recipient lookup failed", err);
    }
    if (recipients.length === 0) {
      await logAttempt(event.id, p.name, `(dept:${event.departmentCode})`, "FAILED", text, "수신자 없음 (no recipients chosen / configured)");
      return;
    }
    await Promise.all(recipients.map((r) => deliver(p, event.id, r, message, text)));
  } catch (err) {
    console.error("[notify] notification step failed", err);
  }
}

/**
 * Sends one message per recipient and logs every attempt (shared by the escalation). Never throws.
 * Recipients without a linked KakaoTalk are logged as FAILED by the provider.
 */
export async function sendToRecipients(eventId: string, recipients: NotificationRecipient[], message: NotificationMessage): Promise<number> {
  const p = getProvider();
  const text = `${message.title}\n${message.body}\n${message.link}`;
  if (recipients.length === 0) {
    await logAttempt(eventId, p.name, "(escalation)", "FAILED", text, "수신자 없음 (no plant manager / team leader configured)");
    return 0;
  }
  const ok = await Promise.all(recipients.map((r) => deliver(p, eventId, r, message, text)));
  return ok.filter(Boolean).length;
}

/**
 * One recipient: KakaoTalk (provider) and phone push (every device the person turned on in /me) at the same
 * time — the KakaoTalk memo arrives silently, the push rings. Both attempts are logged; push only when the
 * person has a device. True when at least one channel delivered. Never throws.
 */
async function deliver(p: NotificationProvider, eventId: string, r: NotificationRecipient, message: NotificationMessage, text: string): Promise<boolean> {
  const kakao = (async () => {
    try {
      await p.send(r, message);
      await logAttempt(eventId, p.name, r.name, "SENT", text, null);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[notify] ${p.name} → ${r.name} failed: ${msg}`);
      await logAttempt(eventId, p.name, r.name, "FAILED", text, msg);
      return false;
    }
  })();
  const push = (async () => {
    try {
      const res = await sendPushTo(r.userId, { ...message, tag: eventId });
      if (res.devices === 0) return false;
      await logAttempt(eventId, "push", `${r.name} (${res.sent}/${res.devices})`, res.sent > 0 ? "SENT" : "FAILED", text, res.sent > 0 ? null : res.error);
      return res.sent > 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[notify] push → ${r.name} failed: ${msg}`);
      await logAttempt(eventId, "push", r.name, "FAILED", text, msg);
      return false;
    }
  })();
  const [a, b] = await Promise.all([kakao, push]);
  return a || b;
}

/**
 * Completion notices (plant meeting 2026-10-08):
 *  - equipment (MT) — 수리 완료: all of MT and the line's UAP (SV + GL);
 *  - material shortage 자작품 (in-house part): the line's UAP (SV + GL) and all of PC&L (incl. the PC&L SV);
 *  - material shortage 외주품 (purchased part): the line's UAP (SV + GL) only.
 * Other completions send nothing. Never throws.
 */
export async function notifyAndonClosed(event: AndonEvent): Promise<void> {
  try {
    const row = await db.get("SELECT situations FROM andon_event WHERE id = ?", event.id);
    let sits: string[] = [];
    try {
      sits = JSON.parse((row?.situations as string) || "[]");
    } catch {
      /* none */
    }
    const inhouse = sits.includes("PCL_SHORTAGE_INHOUSE");
    const repair = event.departments.some((d) => d.code === "MT");
    if (!inhouse && !repair && !sits.includes("PCL_SHORTAGE_PURCHASED")) return;
    const { lineUapPeople } = await import("../andonService.ts");
    const ids = new Set(await lineUapPeople(event.lineCode));
    const allOf = async (dept: string) => {
      for (const r of await db.all("SELECT u.id FROM app_user u JOIN role r ON r.code = u.role WHERE u.active = 1 AND r.can_respond = 1 AND u.department_code = ?", dept)) ids.add(r.id as number);
    };
    if (inhouse) await allOf("PCL");
    if (repair) await allOf("MT");
    const people = ids.size
      ? await db.all(
          `SELECT u.id, u.name, u.department_code,
                  (SELECT c.recipient_id FROM user_notification_channel c
                   WHERE c.user_id = u.id AND c.provider = 'KAKAO' AND c.verified = 1 AND c.active = 1 ORDER BY c.id LIMIT 1) AS kakao
           FROM app_user u WHERE u.active = 1 AND u.id IN (${[...ids].map(() => "?").join(",")}) ORDER BY u.id`,
          ...ids,
        )
      : [];
    const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
    await sendToRecipients(
      event.id,
      people.map((u) => ({ userId: u.id as number, name: u.name as string, departmentCode: u.department_code as string, address: (u.kakao as string | null) ?? null })),
      {
        title: `[ANDON ${repair ? "수리 완료" : "완료"}] ${event.lineName} · ${event.situations.join(", ") || event.categoryName}`,
        body: `${event.id} · 조치: ${event.correctiveAction ?? "-"}`,
        link: `${base}/respond/${encodeURIComponent(event.id)}`,
      },
    );
  } catch (err) {
    console.error("[notify] completion notice failed", err);
  }
}
