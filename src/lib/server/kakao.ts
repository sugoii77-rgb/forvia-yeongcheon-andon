// KakaoTalk "send to me" (나에게 보내기) — thin Kakao API client + token encryption.
// Endpoints: kauth.kakao.com (OAuth), kapi.kakao.com (user id, memo send, unlink). Base URLs can be
// overridden (KAKAO_AUTH_BASE / KAKAO_API_BASE) for the offline test with a fake Kakao server.
// Tokens, codes and the client secret are NEVER logged or returned; errors carry only short codes.
import crypto from "node:crypto";

export interface KakaoConfig {
  restKey: string;
  clientSecret: string;
  authBase: string;
  apiBase: string;
}

export function kakaoConfig(): KakaoConfig | null {
  const restKey = (process.env.KAKAO_REST_API_KEY || "").trim();
  const clientSecret = (process.env.KAKAO_CLIENT_SECRET || "").trim();
  if (!restKey || !clientSecret) return null;
  return {
    restKey,
    clientSecret,
    authBase: (process.env.KAKAO_AUTH_BASE || "https://kauth.kakao.com").replace(/\/$/, ""),
    apiBase: (process.env.KAKAO_API_BASE || "https://kapi.kakao.com").replace(/\/$/, ""),
  };
}

export class KakaoError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------- token encryption (AES-256-GCM)
// Key derived from the client secret (HKDF), so no extra secret has to be managed. Rotating the client
// secret makes stored tokens unreadable → the employee simply links Kakao again.

function tokenKey(cfg: KakaoConfig): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", cfg.clientSecret, "forvia-andon", "kakao-token-v1", 32));
}

export function encryptToken(cfg: KakaoConfig, plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", tokenKey(cfg), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
}

export function decryptToken(cfg: KakaoConfig, enc: string): string {
  const [v, iv, tag, ct] = enc.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new KakaoError("TOKEN_FORMAT");
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", tokenKey(cfg), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    throw new KakaoError("TOKEN_DECRYPT");
  }
}

// ---------------------------------------------------------------- HTTP

async function call(url: string, init: RequestInit, failCode: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000), cache: "no-store" });
  } catch {
    throw new KakaoError(`${failCode}_NETWORK`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Kakao errors: { error: "invalid_grant", ... } (auth) or { code: -401, msg } (api) — keep only the code.
    const detail = typeof body.error === "string" ? body.error : typeof body.code === "number" ? String(body.code) : String(res.status);
    throw new KakaoError(`${failCode}:${detail}`.slice(0, 80), res.status);
  }
  return body;
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
  body: new URLSearchParams(fields).toString(),
});

export function authorizeUrl(cfg: KakaoConfig, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ response_type: "code", client_id: cfg.restKey, redirect_uri: redirectUri, scope: "talk_message", state });
  return `${cfg.authBase}/oauth/authorize?${q}`;
}

export interface KakaoTokens {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string | null;
  refreshExpiresAt: string | null;
  scope: string;
}

function toTokens(b: Record<string, unknown>): KakaoTokens {
  if (typeof b.access_token !== "string") throw new KakaoError("TOKEN_RESPONSE");
  const now = Date.now();
  return {
    accessToken: b.access_token,
    accessExpiresAt: new Date(now + Number(b.expires_in ?? 0) * 1000).toISOString(),
    refreshToken: typeof b.refresh_token === "string" ? b.refresh_token : null,
    refreshExpiresAt: b.refresh_token_expires_in != null ? new Date(now + Number(b.refresh_token_expires_in) * 1000).toISOString() : null,
    scope: typeof b.scope === "string" ? b.scope : "",
  };
}

export async function exchangeCode(cfg: KakaoConfig, code: string, redirectUri: string): Promise<KakaoTokens> {
  return toTokens(
    await call(`${cfg.authBase}/oauth/token`, form({ grant_type: "authorization_code", client_id: cfg.restKey, client_secret: cfg.clientSecret, redirect_uri: redirectUri, code }), "TOKEN"),
  );
}

/** Kakao returns a new refresh token only when the old one is close to expiry. */
export async function refreshTokens(cfg: KakaoConfig, refreshToken: string): Promise<KakaoTokens> {
  return toTokens(
    await call(`${cfg.authBase}/oauth/token`, form({ grant_type: "refresh_token", client_id: cfg.restKey, client_secret: cfg.clientSecret, refresh_token: refreshToken }), "REFRESH"),
  );
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function kakaoUserId(cfg: KakaoConfig, accessToken: string): Promise<string> {
  const b = await call(`${cfg.apiBase}/v2/user/me`, { headers: bearer(accessToken) }, "USER");
  if (b.id == null) throw new KakaoError("USER_RESPONSE");
  return String(b.id);
}

/** Text message to the user's own "나와의 채팅". `text` ≤ 200 chars; `link` opens the ANDON page. */
export async function sendMemo(cfg: KakaoConfig, accessToken: string, text: string, link: string, buttonTitle = "ANDON 보기"): Promise<void> {
  const template = { object_type: "text", text: text.slice(0, 200), link: { web_url: link, mobile_web_url: link }, button_title: buttonTitle };
  const res = await call(
    `${cfg.apiBase}/v2/api/talk/memo/default/send`,
    { ...form({ template_object: JSON.stringify(template) }), headers: { ...form({}).headers, ...bearer(accessToken) } },
    "SEND",
  );
  if (res.result_code !== undefined && Number(res.result_code) !== 0) throw new KakaoError("SEND_RESULT");
}

export async function unlinkKakao(cfg: KakaoConfig, accessToken: string): Promise<void> {
  await call(`${cfg.apiBase}/v1/user/unlink`, { method: "POST", headers: bearer(accessToken) }, "UNLINK");
}
