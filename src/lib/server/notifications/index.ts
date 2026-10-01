// Notification layer. ANDON business logic only calls `notifyAndonCreated(event)`.
// To add KakaoTalk: implement NotificationProvider in kakaoProvider.ts and
// register it in createProvider() below. No other code needs to change.
import type { AndonEvent } from "../../domain";
import { getDb, nowIso } from "../db";
import { primaryRecipients } from "../routingService";

export interface NotificationRecipient {
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

function createProvider(): NotificationProvider {
  const name = process.env.NOTIFICATION_PROVIDER || "mock";
  switch (name) {
    case "mock":
      return new MockNotificationProvider();
    // case "kakao": return new KakaoNotificationProvider(process.env.KAKAO_...);
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
function resolveRecipients(event: AndonEvent): NotificationRecipient[] {
  return primaryRecipients(event.departmentCode).map((u) => ({
    name: u.name,
    departmentCode: u.departmentCode,
    address: u.kakaoId,
  }));
}

/**
 * Sends notifications for a new ANDON and logs every attempt.
 * Never throws: a notification failure must not fail ANDON creation.
 */
export async function notifyAndonCreated(event: AndonEvent): Promise<void> {
  const db = getDb();
  const log = db.prepare(
    `INSERT INTO notification_log (event_id, provider, recipient, status, message, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const p = getProvider();
  const message = buildAndonMessage(event);
  const text = `${message.title}\n${message.body}\n${message.link}`;

  let recipients: NotificationRecipient[] = [];
  try {
    recipients = resolveRecipients(event);
  } catch (err) {
    console.error("[notify] recipient lookup failed", err);
  }
  if (recipients.length === 0) {
    log.run(event.id, p.name, `(dept:${event.departmentCode})`, "FAILED", text, "수신자 없음 (no recipients configured)", nowIso());
    return;
  }

  for (const r of recipients) {
    try {
      await p.send(r, message);
      log.run(event.id, p.name, r.name, "SENT", text, null, nowIso());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[notify] ${p.name} → ${r.name} failed: ${msg}`);
      try {
        log.run(event.id, p.name, r.name, "FAILED", text, msg, nowIso());
      } catch (logErr) {
        console.error("[notify] could not write notification_log", logErr);
      }
    }
  }
}
