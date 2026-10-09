// Phone push notifications (Web Push, schema v11). KakaoTalk "send to me" lands in the employee's own chat
// WITHOUT a sound, so ANDON messages are also pushed to every device the employee turned on in /me — those
// ring with the phone's normal notification sound. Sent next to KakaoTalk, never instead of it.
//
// VAPID key: VAPID_PRIVATE_KEY (base64url, 32 bytes) or — so no extra secret has to be managed — derived
// from KAKAO_CLIENT_SECRET (HKDF, like the Kakao token key). Rotating that secret changes the key; devices
// then simply have to be turned on again. Without either, push is "not configured" and the card is hidden.
//
// The request is built by the web-push library (VAPID JWT + aes128gcm payload encryption) and sent with
// fetch, only to the browsers' push services (allow-list below — the endpoint comes from the client).
import crypto from "node:crypto";
import webpush from "web-push";
import { getSessionUser } from "./auth.ts";
import { db, nowIso } from "./db.ts";
import { AndonError } from "./errors.ts";

export interface PushMessage {
  title: string;
  body: string;
  link: string;
  /** Same tag = the newer notification replaces the older one (one per ANDON). */
  tag?: string;
  /**
   * One-tap acknowledge from the notification (2026-10-09): the service worker shows a button with this
   * title and, when tapped, sends ACKNOWLEDGE for `eventId` with the device's own session. The server still
   * checks the user's right to acknowledge, exactly as on the respond page.
   */
  ack?: { eventId: string; title: string };
}

const PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome / Edge / Samsung Internet on Android, Chrome desktop
  ".push.apple.com", // Safari / iPhone home-screen app (iOS 16.4+)
  ".push.services.mozilla.com", // Firefox
  ".notify.windows.com", // Edge (legacy)
];

function allowedEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  const testOrigin = process.env.PUSH_TEST_ENDPOINT_ORIGIN?.trim(); // offline tests only
  if (testOrigin && u.origin === testOrigin) return true;
  if (u.protocol !== "https:" || u.port) return false;
  return PUSH_HOSTS.some((h) => (h.startsWith(".") ? u.hostname.endsWith(h) : u.hostname === h));
}

type Vapid = { publicKey: string; privateKey: string; subject: string };
let cached: Vapid | null | undefined;

export function vapidKeys(): Vapid | null {
  if (cached !== undefined) return cached;
  const explicit = process.env.VAPID_PRIVATE_KEY?.trim();
  const secret = (process.env.KAKAO_CLIENT_SECRET || "").trim();
  let priv: Buffer | null = null;
  if (explicit) priv = Buffer.from(explicit, "base64url");
  else if (secret) priv = Buffer.from(crypto.hkdfSync("sha256", secret, "forvia-andon", "web-push-vapid-v1", 32));
  if (!priv || priv.length !== 32) return (cached = null);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(priv);
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const subject = process.env.VAPID_SUBJECT?.trim() || (base.startsWith("https://") ? base : "https://forvia-yeongcheon-andon.vercel.app");
  return (cached = { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: priv.toString("base64url"), subject });
}

async function requireUser(req: Request) {
  const user = await getSessionUser(req);
  if (!user) throw new AndonError(401, "로그인이 필요합니다.", "AUTH_REQUIRED");
  if (!user.active) throw new AndonError(403, "비활성(사용 중지)된 계정입니다.", "ACCOUNT_INACTIVE");
  return user;
}

export interface PushStatus {
  configured: boolean;
  publicKey: string | null;
  /** Devices of this user with push turned on. */
  devices: number;
}

export async function pushStatusFor(req: Request): Promise<PushStatus> {
  const user = await requireUser(req);
  const v = vapidKeys();
  const row = await db.get("SELECT COUNT(*) AS n FROM push_subscription WHERE user_id = ?", user.id);
  return { configured: !!v, publicKey: v?.publicKey ?? null, devices: Number(row?.n ?? 0) };
}

/** Body = the browser's PushSubscription.toJSON(). Re-subscribing the same device moves it to this user. */
export async function subscribeFor(req: Request, body: unknown, oldEndpoint?: string): Promise<void> {
  const user = await requireUser(req);
  if (!vapidKeys()) throw new AndonError(503, "푸시 알림이 설정되지 않았습니다.", "PUSH_NOT_CONFIGURED");
  const b = (body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof b.endpoint === "string" ? b.endpoint : "";
  const p256dh = typeof b.keys?.p256dh === "string" ? b.keys.p256dh : "";
  const auth = typeof b.keys?.auth === "string" ? b.keys.auth : "";
  if (endpoint.length > 1000 || !allowedEndpoint(endpoint)) throw new AndonError(400, "지원하지 않는 푸시 주소입니다.", "PUSH_BAD_ENDPOINT");
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) {
    throw new AndonError(400, "푸시 구독 정보가 올바르지 않습니다.", "PUSH_BAD_KEYS");
  }
  const ua = (req.headers.get("user-agent") || "").slice(0, 300) || null;
  await db.transaction(async () => {
    if (oldEndpoint) await db.run("DELETE FROM push_subscription WHERE endpoint = ? AND user_id = ?", oldEndpoint, user.id);
    await db.run("DELETE FROM push_subscription WHERE endpoint = ?", endpoint);
    await db.run(
      "INSERT INTO push_subscription (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      user.id, endpoint, p256dh, auth, ua, nowIso(),
    );
  });
}

export async function unsubscribeFor(req: Request, endpoint: unknown): Promise<void> {
  const user = await requireUser(req);
  if (typeof endpoint !== "string" || !endpoint) throw new AndonError(400, "endpoint가 필요합니다.", "PUSH_BAD_ENDPOINT");
  await db.run("DELETE FROM push_subscription WHERE endpoint = ? AND user_id = ?", endpoint, user.id);
}

/**
 * Pushes to every device of the user. Returns how many devices accepted it ({sent: 0, devices: 0} when the
 * user has none — not an error). Devices the push service reports as gone (404 / 410) are removed.
 */
export async function sendPushTo(userId: number, m: PushMessage): Promise<{ sent: number; devices: number; error: string | null }> {
  const v = vapidKeys();
  const subs = (await db.all("SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = ? ORDER BY id", userId)) as {
    id: number; endpoint: string; p256dh: string; auth: string;
  }[];
  if (!v || subs.length === 0) return { sent: 0, devices: subs.length, error: v ? null : "PUSH_NOT_CONFIGURED" };
  const payload = JSON.stringify({ title: m.title, body: m.body, url: m.link, tag: m.tag ?? null, ack: m.ack ?? null });
  let sent = 0;
  let lastError: string | null = null;
  await Promise.all(
    subs.map(async (s) => {
      try {
        if (!allowedEndpoint(s.endpoint)) throw new Error("endpoint not allowed");
        const r = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          vapidDetails: v,
          TTL: 3600, // an ANDON older than 1 h is not worth ringing a phone that was off
          urgency: "high",
          contentEncoding: "aes128gcm",
        });
        const res = await fetch(r.endpoint, {
          method: r.method,
          headers: r.headers as Record<string, string>,
          body: r.body ? new Uint8Array(r.body) : undefined,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404 || res.status === 410) {
          await db.run("DELETE FROM push_subscription WHERE id = ?", s.id);
          throw new Error(`device gone (${res.status}) — removed`);
        }
        if (!res.ok) throw new Error(`push service ${res.status}`);
        await db.run("UPDATE push_subscription SET last_sent_at = ?, last_error = NULL WHERE id = ?", nowIso(), s.id);
        sent++;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await db.run("UPDATE push_subscription SET last_error = ? WHERE id = ?", lastError.slice(0, 300), s.id).catch(() => {});
      }
    }),
  );
  return { sent, devices: subs.length, error: lastError };
}

export async function sendPushTest(req: Request): Promise<{ sent: number; devices: number }> {
  const user = await requireUser(req);
  const base = new URL(req.url).origin;
  const r = await sendPushTo(user.id, {
    title: "[DIGITAL ANDON] 테스트 알림",
    body: "알림음이 울렸다면 설정 완료입니다. 실제 ANDON 발생 시 이 형식으로 도착합니다.",
    link: `${base}/me`,
    tag: "andon-test",
  });
  if (r.devices === 0) throw new AndonError(400, "이 계정에 알림이 켜진 기기가 없습니다.", "PUSH_NO_DEVICE");
  if (r.sent === 0) throw new AndonError(502, `푸시 발송 실패: ${r.error ?? "unknown"}`, "PUSH_SEND_FAILED");
  return { sent: r.sent, devices: r.devices };
}
