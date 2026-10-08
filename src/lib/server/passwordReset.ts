// Self-service password reset (2026-10-08). Identity proof = the employee's own KakaoTalk: a 6-digit code is
// sent to the "나와의 채팅" of the Kakao account the employee linked on /me (OAuth, verified channel).
// E-mail cannot be used (GAP leaders have none; e-mails are not stored when the login is the 사번).
//  - The answer to "send me a code" is the same whether or not the login exists / has Kakao (no enumeration).
//  - Only a hash of the code is stored; 10 minutes, 5 wrong attempts, one-time; a new request replaces it.
//  - Requests and wrong codes count towards the login throttle (per login ID + IP).
//  - A successful reset ends ALL sessions of the employee.
import crypto from "node:crypto";
import { assertNotLocked, clearFailures, hashPassword, normalizeEmail, recordFailure, throttleKey, validatePassword } from "./auth.ts";
import { db, nowIso } from "./db.ts";
import { AndonError, type AuditInfo } from "./errors.ts";
import { sendKakaoMemoTo } from "./kakaoNotify.ts";

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const hash = (userId: number, code: string) => crypto.createHash("sha256").update(`reset:${userId}:${code}`).digest("hex");

/** The LOCAL login of a 사번 or e-mail (same lookup as login). */
async function findLogin(loginInput: unknown): Promise<{ user_id: number } | undefined> {
  const login = normalizeEmail(loginInput);
  if (!login || login.length > 254) return undefined;
  const bySubject = (await db.get("SELECT i.user_id FROM user_identity i JOIN app_user u ON u.id = i.user_id WHERE i.provider = 'LOCAL' AND i.subject = ? AND u.active = 1", login)) as
    | { user_id: number }
    | undefined;
  if (bySubject || login.includes("@")) return bySubject;
  return (await db.get(
    "SELECT i.user_id FROM user_identity i JOIN app_user u ON u.id = i.user_id WHERE i.provider = 'LOCAL' AND u.employee_id = ? AND u.active = 1",
    login.toUpperCase(),
  )) as { user_id: number } | undefined;
}

export const RESET_REQUESTED_MESSAGE =
  "카카오 알림이 연결된 계정이면 카카오톡 '나와의 채팅'으로 인증번호를 보냈습니다 (10분 안에 입력). 카카오 알림을 연결하지 않았다면 시스템 담당자에게 재설정을 요청하세요.";

/** Step 1: send a code to the employee's own KakaoTalk. Always the same answer. */
export async function requestPasswordReset(loginInput: unknown, appOrigin: string, audit: AuditInfo): Promise<string> {
  const key = throttleKey(`reset:${normalizeEmail(loginInput)}`, audit.clientIp);
  await assertNotLocked(key);
  await recordFailure(key); // every request counts: at most 5 per 15 minutes
  const row = await findLogin(loginInput);
  if (!row) return RESET_REQUESTED_MESSAGE;
  const linked = await db.get(
    "SELECT 1 FROM user_notification_channel WHERE user_id = ? AND provider = 'KAKAO' AND verified = 1 AND active = 1",
    row.user_id,
  );
  if (!linked) return RESET_REQUESTED_MESSAGE;
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const now = Date.now();
  await db.run(
    `INSERT INTO password_reset_code (user_id, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`,
    row.user_id,
    hash(row.user_id, code),
    new Date(now + CODE_TTL_MS).toISOString(),
    new Date(now).toISOString(),
  );
  const link = new URL("/reset", appOrigin).href;
  try {
    await sendKakaoMemoTo(row.user_id, `[DIGITAL ANDON] 비밀번호 재설정 인증번호: ${code}\n10분 안에 입력하세요. 본인이 요청하지 않았다면 무시하세요.\n${link}`, link);
  } catch (err) {
    console.error(`[reset] code for user #${row.user_id} not delivered: ${(err as Error).message}`);
    await db.run("DELETE FROM password_reset_code WHERE user_id = ?", row.user_id);
  }
  console.info(`[reset] code requested for user #${row.user_id}`);
  return RESET_REQUESTED_MESSAGE;
}

/** Step 2: code + new password. */
export async function confirmPasswordReset(
  input: { login: unknown; code: unknown; newPassword: unknown; newPasswordConfirm: unknown },
  audit: AuditInfo,
): Promise<void> {
  const key = throttleKey(`resetcode:${normalizeEmail(input.login)}`, audit.clientIp);
  await assertNotLocked(key);
  const invalid = () => new AndonError(400, "인증번호가 올바르지 않거나 만료되었습니다. 인증번호를 다시 받으세요.", "INVALID_RESET_CODE");
  const code = typeof input.code === "string" ? input.code.trim() : "";
  const next = typeof input.newPassword === "string" ? input.newPassword : "";
  const confirm = typeof input.newPasswordConfirm === "string" ? input.newPasswordConfirm : "";
  validatePassword(next);
  if (next !== confirm) throw new AndonError(400, "새 비밀번호 확인이 일치하지 않습니다.", "PASSWORD_MISMATCH");
  const row = await findLogin(input.login);
  const rec = row
    ? ((await db.get("SELECT code_hash, expires_at, attempts FROM password_reset_code WHERE user_id = ?", row.user_id)) as
        | { code_hash: string; expires_at: string; attempts: number }
        | undefined)
    : undefined;
  if (!row || !rec || rec.expires_at <= nowIso() || rec.attempts >= MAX_ATTEMPTS || !/^\d{6}$/.test(code)) {
    await recordFailure(key);
    throw invalid();
  }
  const ok = crypto.timingSafeEqual(Buffer.from(hash(row.user_id, code)), Buffer.from(rec.code_hash));
  if (!ok) {
    await db.run("UPDATE password_reset_code SET attempts = attempts + 1 WHERE user_id = ?", row.user_id);
    await recordFailure(key);
    throw invalid();
  }
  const pwHash = await hashPassword(next);
  await db.transaction(async () => {
    await db.run("DELETE FROM password_reset_code WHERE user_id = ?", row.user_id);
    await db.run("UPDATE user_identity SET password_hash = ? WHERE user_id = ? AND provider = 'LOCAL'", pwHash, row.user_id);
    await db.run("UPDATE user_session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", nowIso(), row.user_id);
  });
  await clearFailures(key);
  console.info(`[reset] password reset by user #${row.user_id} (KakaoTalk code)`);
}
