// Notification layer. ANDON business logic only calls `notifyAndonCreated(event)`.
// Providers: "mock" (log only) and "kakao" (KakaoTalk "send to me" — each employee links their own
// Kakao account on /me; see ../kakaoNotify.ts). Selected by NOTIFICATION_PROVIDER.
import type { AndonEvent } from "../../domain.ts";
import { db, nowIso } from "../db.ts";
import { sendKakaoMemoTo } from "../kakaoNotify.ts";
import { primaryRecipients } from "../routingService.ts";

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
 * Initial recipients = active RESPONDER users of the event's responsible department
 * (decided by routingService; escalation roles are notified later, when escalation exists).
 */
async function resolveRecipients(event: AndonEvent): Promise<NotificationRecipient[]> {
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
      await logAttempt(event.id, p.name, `(dept:${event.departmentCode})`, "FAILED", text, "수신자 없음 (no recipients configured)");
      return;
    }
    for (const r of recipients) {
      try {
        await p.send(r, message);
        await logAttempt(event.id, p.name, r.name, "SENT", text, null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[notify] ${p.name} → ${r.name} failed: ${msg}`);
        await logAttempt(event.id, p.name, r.name, "FAILED", text, msg);
      }
    }
  } catch (err) {
    console.error("[notify] notification step failed", err);
  }
}
