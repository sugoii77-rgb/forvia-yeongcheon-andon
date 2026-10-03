// KakaoTalk notifications via "send to me" (나에게 보내기): every employee links their OWN Kakao account
// from /me (OAuth, scope talk_message). The app then posts ANDON calls into that person's "나와의 채팅".
// - The notification address (user_notification_channel, provider KAKAO) is created ONLY by a completed
//   OAuth link + a successfully delivered confirmation memo — never from a typed KakaoTalk ID.
// - Access / refresh tokens are stored AES-256-GCM encrypted (kakao.ts); they never leave the server.
// - The link flow is bound to the session that started it (state hash + session hash, 10 min, one-time).
import crypto from "node:crypto";
import { getSessionUser, readCookie, SESSION_COOKIE } from "./auth.ts";
import { db, nowIso } from "./db.ts";
import { AndonError } from "./errors.ts";
import * as kakao from "./kakao.ts";

const CALLBACK = "/api/notify/kakao/callback";
const FLOW_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function kakaoNotifyConfigured(): boolean {
  return kakao.kakaoConfig() !== null;
}

function requireConfig(): kakao.KakaoConfig {
  const cfg = kakao.kakaoConfig();
  if (!cfg) throw new AndonError(503, "카카오 알림이 아직 설정되지 않았습니다.", "KAKAO_NOT_CONFIGURED");
  return cfg;
}

/** Fixed KAKAO_REDIRECT_URI, else this server's own callback (must be registered in Kakao Developers). */
function redirectUri(req: Request): string {
  const fixed = process.env.KAKAO_REDIRECT_URI?.trim();
  return fixed || new URL(CALLBACK, new URL(req.url).origin).href;
}

function appOrigin(req: Request): string {
  const fixed = process.env.KAKAO_REDIRECT_URI?.trim();
  return fixed ? new URL(fixed).origin : new URL(req.url).origin;
}

async function requireUser(req: Request) {
  const user = await getSessionUser(req);
  if (!user) throw new AndonError(401, "로그인이 필요합니다.", "AUTH_REQUIRED");
  if (!user.active) throw new AndonError(403, "비활성(사용 중지)된 계정입니다.", "ACCOUNT_INACTIVE");
  return user;
}

/** Short, token-free error text for kakao_link.last_error / notification_log. */
function errCode(err: unknown): string {
  return err instanceof kakao.KakaoError ? err.code : err instanceof AndonError ? err.code : "KAKAO_ERROR";
}

// ---------------------------------------------------------------- status

export interface KakaoStatus {
  configured: boolean;
  linked: boolean;
  /** Linked AND usable (verified channel). False after a failed token refresh → link again. */
  active: boolean;
  linkedAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
}

export async function kakaoStatus(userId: number): Promise<KakaoStatus> {
  const r = await db.get(
    `SELECT k.linked_at, k.last_sent_at, k.last_error,
            EXISTS(SELECT 1 FROM user_notification_channel c WHERE c.user_id = k.user_id AND c.provider = 'KAKAO'
                   AND c.recipient_id = k.kakao_user_id AND c.verified = 1 AND c.active = 1) AS ok
     FROM kakao_link k WHERE k.user_id = ?`,
    userId,
  );
  return {
    configured: kakaoNotifyConfigured(),
    linked: !!r,
    active: r?.ok === 1,
    linkedAt: (r?.linked_at as string | undefined) ?? null,
    lastSentAt: (r?.last_sent_at as string | undefined) ?? null,
    lastError: (r?.last_error as string | undefined) ?? null,
  };
}

// ---------------------------------------------------------------- link flow

export async function beginKakaoLink(req: Request): Promise<{ url: string }> {
  const cfg = requireConfig();
  const user = await requireUser(req);
  const state = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await db.transaction(async () => {
    await db.run("DELETE FROM kakao_link_flow WHERE expires_at <= ? OR user_id = ?", now.toISOString(), user.id);
    await db.run(
      "INSERT INTO kakao_link_flow (state_hash, user_id, session_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      sha256(state),
      user.id,
      sha256(readCookie(req, SESSION_COOKIE) ?? ""),
      now.toISOString(),
      new Date(now.getTime() + FLOW_TTL_MS).toISOString(),
    );
  });
  return { url: kakao.authorizeUrl(cfg, redirectUri(req), state) };
}

/**
 * OAuth callback. One-time state, same user + same session as the start, talk_message granted, Kakao
 * account not linked to another employee, confirmation memo delivered — only then the channel is verified.
 */
export async function completeKakaoLink(req: Request): Promise<void> {
  const cfg = requireConfig();
  const q = new URL(req.url).searchParams;
  const state = q.get("state");
  if (!state || q.getAll("state").length !== 1 || state.length > 100) throw new AndonError(400, "연결 요청이 만료되었거나 일치하지 않습니다.", "KAKAO_INVALID_STATE");
  // Consume the state first (one-time even if anything below fails).
  const flow = (await db.get("DELETE FROM kakao_link_flow WHERE state_hash = ? AND expires_at > ? RETURNING user_id, session_hash", sha256(state), nowIso())) as
    | { user_id: number; session_hash: string }
    | undefined;
  if (!flow) throw new AndonError(400, "연결 요청이 만료되었거나 일치하지 않습니다.", "KAKAO_INVALID_STATE");
  const user = await getSessionUser(req);
  if (!user || !user.active || user.id !== flow.user_id || sha256(readCookie(req, SESSION_COOKIE) ?? "") !== flow.session_hash) {
    throw new AndonError(403, "연결을 시작한 계정으로 다시 로그인하세요.", "KAKAO_SESSION_CHANGED");
  }
  if (q.get("error")) throw new AndonError(400, "카카오 동의가 취소되었습니다.", "KAKAO_DENIED");
  const code = q.get("code");
  if (!code || code.length > 2000) throw new AndonError(400, "카카오 인증 코드가 없습니다.", "KAKAO_NO_CODE");

  const tokens = await kakao.exchangeCode(cfg, code, redirectUri(req)).catch((err) => {
    throw new AndonError(502, "카카오 인증에 실패했습니다. 다시 시도하세요.", errCode(err));
  });
  if (!tokens.scope.split(/[\s,]+/).includes("talk_message")) {
    throw new AndonError(400, "'카카오톡 메시지 전송' 동의가 필요합니다.", "KAKAO_SCOPE_MISSING");
  }
  if (!tokens.refreshToken) throw new AndonError(502, "카카오 인증에 실패했습니다. 다시 시도하세요.", "KAKAO_NO_REFRESH");
  const kakaoId = await kakao.kakaoUserId(cfg, tokens.accessToken).catch((err) => {
    throw new AndonError(502, "카카오 계정 정보를 확인할 수 없습니다.", errCode(err));
  });
  const other = await db.get("SELECT user_id FROM kakao_link WHERE kakao_user_id = ? AND user_id <> ?", kakaoId, user.id);
  if (other) throw new AndonError(409, "이 카카오 계정은 다른 직원에게 이미 연결되어 있습니다.", "KAKAO_ALREADY_LINKED");

  // Proof that delivery works BEFORE the address becomes a verified notification channel.
  const me = new URL("/me", appOrigin(req)).href;
  await kakao.sendMemo(cfg, tokens.accessToken, `[DIGITAL ANDON] 카카오 알림이 연결되었습니다.\n${user.name} 님 부서의 ANDON 발생 시 이 채팅으로 알려드립니다.\n${me}`, me, "내 정보").catch((err) => {
    throw new AndonError(502, "확인 메시지를 보내지 못했습니다. 다시 시도하세요.", errCode(err));
  });

  const now = nowIso();
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO kakao_link (user_id, kakao_user_id, access_token_enc, access_expires_at, refresh_token_enc, refresh_expires_at, scope, linked_at, updated_at, last_sent_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(user_id) DO UPDATE SET kakao_user_id = excluded.kakao_user_id, access_token_enc = excluded.access_token_enc,
         access_expires_at = excluded.access_expires_at, refresh_token_enc = excluded.refresh_token_enc,
         refresh_expires_at = excluded.refresh_expires_at, scope = excluded.scope, linked_at = excluded.linked_at,
         updated_at = excluded.updated_at, last_sent_at = excluded.last_sent_at, last_error = NULL`,
      user.id,
      kakaoId,
      kakao.encryptToken(cfg, tokens.accessToken),
      tokens.accessExpiresAt,
      kakao.encryptToken(cfg, tokens.refreshToken!),
      tokens.refreshExpiresAt,
      tokens.scope.slice(0, 200),
      now,
      now,
      now,
    );
    await db.run("DELETE FROM user_notification_channel WHERE provider = 'KAKAO' AND (user_id = ? OR recipient_id = ?)", user.id, kakaoId);
    await db.run(
      "INSERT INTO user_notification_channel (user_id, provider, recipient_id, verified, active, created_at) VALUES (?, 'KAKAO', ?, 1, 1, ?)",
      user.id,
      kakaoId,
      now,
    );
  });
  console.info(`[kakao] user #${user.id} linked KakaoTalk notifications`);
}

// ---------------------------------------------------------------- sending

interface LinkRow {
  kakao_user_id: string;
  access_token_enc: string;
  access_expires_at: string;
  refresh_token_enc: string;
}

/** Marks the link unusable (channel unverified) and records why. The employee must link again. */
async function disable(userId: number, reason: string) {
  await db.run("UPDATE kakao_link SET last_error = ?, updated_at = ? WHERE user_id = ?", reason, nowIso(), userId);
  await db.run("UPDATE user_notification_channel SET verified = 0 WHERE user_id = ? AND provider = 'KAKAO'", userId);
}

async function validAccessToken(cfg: kakao.KakaoConfig, userId: number, link: LinkRow): Promise<string> {
  if (new Date(link.access_expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS) {
    try {
      return kakao.decryptToken(cfg, link.access_token_enc);
    } catch {
      // unreadable (e.g. rotated secret) → try the refresh token below
    }
  }
  let refreshed: kakao.KakaoTokens;
  try {
    refreshed = await kakao.refreshTokens(cfg, kakao.decryptToken(cfg, link.refresh_token_enc));
  } catch (err) {
    const code = errCode(err);
    // Network trouble is transient; an invalid / expired refresh token means "link again".
    if (!code.endsWith("_NETWORK")) await disable(userId, code);
    throw new kakao.KakaoError(code);
  }
  await db.run(
    `UPDATE kakao_link SET access_token_enc = ?, access_expires_at = ?,
       refresh_token_enc = COALESCE(?, refresh_token_enc), refresh_expires_at = COALESCE(?, refresh_expires_at), updated_at = ?
     WHERE user_id = ?`,
    kakao.encryptToken(cfg, refreshed.accessToken),
    refreshed.accessExpiresAt,
    refreshed.refreshToken ? kakao.encryptToken(cfg, refreshed.refreshToken) : null,
    refreshed.refreshExpiresAt,
    nowIso(),
    userId,
  );
  return refreshed.accessToken;
}

/**
 * Sends one memo to the employee's own KakaoTalk. Throws a token-free Error when the employee has no
 * usable link (the notification layer logs it as FAILED; ANDON creation is never affected).
 */
export async function sendKakaoMemoTo(userId: number, text: string, link: string): Promise<void> {
  const cfg = requireConfig();
  const row = (await db.get(
    `SELECT k.kakao_user_id, k.access_token_enc, k.access_expires_at, k.refresh_token_enc
     FROM kakao_link k JOIN user_notification_channel c
       ON c.user_id = k.user_id AND c.provider = 'KAKAO' AND c.recipient_id = k.kakao_user_id AND c.verified = 1 AND c.active = 1
     WHERE k.user_id = ?`,
    userId,
  )) as LinkRow | undefined;
  if (!row) throw new Error("카카오 알림 미연결 (KAKAO_NOT_LINKED)");
  try {
    const token = await validAccessToken(cfg, userId, row);
    await kakao.sendMemo(cfg, token, text, link);
  } catch (err) {
    const code = errCode(err);
    // 401 from the API = token revoked on Kakao's side (e.g. the user disconnected the app).
    if (err instanceof kakao.KakaoError && err.status === 401) await disable(userId, code);
    else await db.run("UPDATE kakao_link SET last_error = ?, updated_at = ? WHERE user_id = ?", code, nowIso(), userId);
    throw new Error(`카카오 발송 실패 (${code})`);
  }
  await db.run("UPDATE kakao_link SET last_sent_at = ?, last_error = NULL WHERE user_id = ?", nowIso(), userId);
}

export async function sendKakaoTest(req: Request): Promise<void> {
  const user = await requireUser(req);
  const me = new URL("/me", appOrigin(req)).href;
  try {
    await sendKakaoMemoTo(user.id, `[DIGITAL ANDON] 테스트 알림입니다.\n실제 ANDON 발생 시 이 형식으로 도착합니다.\n${me}`, me);
  } catch (err) {
    throw new AndonError(502, (err as Error).message, "KAKAO_SEND_FAILED");
  }
}

export async function unlinkKakaoFor(req: Request): Promise<void> {
  const user = await requireUser(req);
  const cfg = kakao.kakaoConfig();
  const row = (await db.get("SELECT access_token_enc, access_expires_at, refresh_token_enc, kakao_user_id FROM kakao_link WHERE user_id = ?", user.id)) as LinkRow | undefined;
  if (row && cfg) {
    // Best effort: also disconnect the app on Kakao's side. Local removal happens regardless.
    try {
      await kakao.unlinkKakao(cfg, await validAccessToken(cfg, user.id, row));
    } catch {
      /* ignore */
    }
  }
  await db.transaction(async () => {
    await db.run("DELETE FROM kakao_link WHERE user_id = ?", user.id);
    await db.run("DELETE FROM kakao_link_flow WHERE user_id = ?", user.id);
    await db.run("DELETE FROM user_notification_channel WHERE user_id = ? AND provider = 'KAKAO'", user.id);
  });
  console.info(`[kakao] user #${user.id} unlinked KakaoTalk notifications`);
}

export async function kakaoStatusFor(req: Request): Promise<KakaoStatus> {
  return kakaoStatus((await requireUser(req)).id);
}
