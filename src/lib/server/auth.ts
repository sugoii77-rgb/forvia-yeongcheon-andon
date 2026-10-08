// Local authentication (Milestone 2B): registration, password login, server-side sessions.
// Uses only Node's built-in crypto (scrypt KDF, CSPRNG, SHA-256, timing-safe compare) — no custom crypto.
//
// Design for future identity providers: credentials live in user_identity(provider, subject), not in
// app_user. GOOGLE / KAKAO login would add rows with provider = 'GOOGLE' / 'KAKAO' for the same user;
// routing and responder eligibility only ever look at app_user (department, role, active).
import crypto from "node:crypto";
import { promisify } from "node:util";
import { DEPARTMENT_CODES, SELF_REGISTRATION_ROLE, type PublicUser, type RoleCode } from "../domain.ts";
import { db, nowIso } from "./db.ts";
import { AndonError, type AuditInfo } from "./errors.ts";
import { departmentLabelMap } from "./routingService.ts";

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

// ---------------------------------------------------------------- passwords

// OWASP-recommended scrypt parameters (N=2^15, r=8, p=3 ≈ 32 MiB). Stored with each hash so they can
// be raised later without breaking existing accounts.
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, keylen: 64, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  const key = await scrypt(password.normalize("NFKC"), salt, expected.length, { N, r, p, maxmem: SCRYPT.maxmem });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Used to spend the same time for unknown e-mails as for wrong passwords (no account enumeration by timing).
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex")));

// ---------------------------------------------------------------- validation

export function normalizeEmail(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePassword(password: string) {
  if (password.length < 8 || password.length > 128) {
    throw new AndonError(400, "비밀번호는 8자 이상 128자 이하로 입력하세요.", "INVALID_PASSWORD");
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new AndonError(400, "비밀번호에는 영문자와 숫자가 모두 포함되어야 합니다.", "INVALID_PASSWORD");
  }
}

// ---------------------------------------------------------------- users

const PUBLIC_USER_SELECT = `
SELECT u.id, u.employee_id, u.name, u.email, u.department_code, u.role, u.active, r.name_ko AS role_name, r.can_respond,
       EXISTS(SELECT 1 FROM user_identity i WHERE i.user_id=u.id AND i.provider='GOOGLE') AS google_linked
FROM app_user u JOIN role r ON r.code = u.role`;

function toPublicUser(r: Record<string, unknown>, labels: Map<string, string>): PublicUser {
  return {
    id: r.id as number,
    employeeId: (r.employee_id as string | null) ?? null,
    googleLinked: r.google_linked === 1,
    name: r.name as string,
    email: (r.email as string | null) ?? null,
    departmentCode: r.department_code as string,
    departmentLabel: labels.get(r.department_code as string) ?? (r.department_code as string),
    role: r.role as RoleCode,
    roleName: r.role_name as string,
    active: r.active === 1,
    canRespond: r.active === 1 && r.can_respond === 1,
  };
}

export async function getPublicUser(userId: number): Promise<PublicUser | null> {
  const r = await db.get(`${PUBLIC_USER_SELECT} WHERE u.id = ?`, userId);
  return r ? toPublicUser(r, await departmentLabelMap()) : null;
}

export interface RegistrationInput {
  name: unknown;
  email: unknown;
  department: unknown;
  password: unknown;
  passwordConfirm: unknown;
}

/**
 * Self-registration. The role is ALWAYS RESPONDER and the account is active; any role sent by the
 * client is ignored. Department must be one of the active operational departments.
 */
export async function registerUser(input: RegistrationInput): Promise<PublicUser> {
  const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
  const email = normalizeEmail(input.email);
  const department = String(input.department ?? "").trim();
  const password = typeof input.password === "string" ? input.password : "";
  const confirm = typeof input.passwordConfirm === "string" ? input.passwordConfirm : "";

  if (!name || name.length > 40 || /[\u0000-\u001f<>]/.test(name)) {
    throw new AndonError(400, "이름을 1~40자로 입력하세요.", "INVALID_NAME");
  }
  if (!EMAIL.test(email) || email.length > 254) throw new AndonError(400, "이메일 형식이 올바르지 않습니다.", "INVALID_EMAIL");
  const dep = (await db.get("SELECT code FROM department WHERE code = ? AND active = 1", department));
  if (!dep || !(DEPARTMENT_CODES as readonly string[]).includes(department)) {
    throw new AndonError(400, "부서를 목록에서 선택하세요.", "INVALID_DEPARTMENT");
  }
  validatePassword(password);
  if (password !== confirm) throw new AndonError(400, "비밀번호 확인이 일치하지 않습니다.", "PASSWORD_MISMATCH");

  const hash = await hashPassword(password); // async: before the (synchronous) transaction
  const now = nowIso();
  let userId: number;
  try {
    userId = await db.transaction(async () => {
      const taken =
        (await db.get("SELECT 1 FROM app_user WHERE email = ?", email)) ??
        (await db.get("SELECT 1 FROM user_identity WHERE provider = 'LOCAL' AND subject = ?", email));
      if (taken) throw new AndonError(409, "이미 가입된 이메일입니다.", "EMAIL_TAKEN");
      const u = (await db.run(`INSERT INTO app_user (name, email, department_code, role, active, source, created_at)
           VALUES (?, ?, ?, ?, 1, 'REGISTRATION', ?)`, name, email, department, SELF_REGISTRATION_ROLE, now));
      const id = Number(u.lastInsertRowid);
      (await db.run("INSERT INTO user_identity (user_id, provider, subject, password_hash, created_at) VALUES (?, 'LOCAL', ?, ?, ?)", id, email, hash, now));
      return id;
    });
  } catch (err) {
    // Unique indexes are the final guard against two simultaneous registrations with the same e-mail.
    if (err instanceof AndonError) throw err;
    if (/UNIQUE constraint failed/.test(String((err as Error).message))) {
      throw new AndonError(409, "이미 가입된 이메일입니다.", "EMAIL_TAKEN");
    }
    throw err;
  }
  console.info(`[auth] registered user #${userId} (${department}, ${SELF_REGISTRATION_ROLE})`);
  return (await getPublicUser(userId))!;
}

// ---------------------------------------------------------------- login throttling

// Per e-mail + IP: 5 failures within 15 minutes → locked until the window ends. Stored in the database
// (table login_throttle, schema v5) so that every server instance — also on Vercel — shares the counter.
// The key is a SHA-256 hash, so the table holds no plain e-mail addresses.
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_LIMIT = 5;

export function throttleKey(email: string, ip: string | null) {
  return crypto.createHash("sha256").update(`${email}|${ip ?? "-"}`).digest("hex");
}
export async function assertNotLocked(key: string) {
  const f = (await db.get("SELECT failures, first_failure_at FROM login_throttle WHERE throttle_key = ?", key)) as
    | { failures: number; first_failure_at: string }
    | undefined;
  if (f && Date.now() - new Date(f.first_failure_at).getTime() < FAIL_WINDOW_MS && f.failures >= FAIL_LIMIT) {
    throw new AndonError(429, "로그인 실패가 많습니다. 15분 후 다시 시도하세요.", "TOO_MANY_ATTEMPTS");
  }
}
export async function recordFailure(key: string) {
  const windowStart = new Date(Date.now() - FAIL_WINDOW_MS).toISOString();
  // One atomic upsert: start a new window if the old one expired, otherwise count up.
  await db.run(
    `INSERT INTO login_throttle (throttle_key, failures, first_failure_at) VALUES (?1, 1, ?2)
     ON CONFLICT(throttle_key) DO UPDATE SET
       failures = CASE WHEN first_failure_at < ?3 THEN 1 ELSE failures + 1 END,
       first_failure_at = CASE WHEN first_failure_at < ?3 THEN ?2 ELSE first_failure_at END`,
    key,
    nowIso(),
    windowStart,
  );
}
export async function clearFailures(key: string) {
  await db.run("DELETE FROM login_throttle WHERE throttle_key = ?", key);
}

/** Verifies e-mail + password. Returns the user or throws (same message for unknown e-mail and wrong password). */
/**
 * Login ID = e-mail or employee number (사번, plant decision 2026-10-08: GAP leaders have no company e-mail).
 * A 사번 matches the LOCAL login whose subject is that number, or the LOCAL login of the employee with
 * that employee_id.
 */
export async function authenticate(emailInput: unknown, passwordInput: unknown, audit: AuditInfo): Promise<PublicUser> {
  const email = normalizeEmail(emailInput);
  const password = typeof passwordInput === "string" ? passwordInput : "";
  const key = throttleKey(email, audit.clientIp);
  await assertNotLocked(key);

  let row = (await db.get("SELECT user_id, password_hash, subject FROM user_identity WHERE provider = 'LOCAL' AND subject = ?", email)) as
    | { user_id: number; password_hash: string | null; subject: string }
    | undefined;
  if (!row && email && !email.includes("@") && email.length <= 40) {
    row = (await db.get(
      `SELECT i.user_id, i.password_hash, i.subject FROM user_identity i JOIN app_user u ON u.id = i.user_id
       WHERE i.provider = 'LOCAL' AND u.employee_id = ?`,
      email.toUpperCase(),
    )) as typeof row;
  }
  const ok = row?.password_hash
    ? await verifyPassword(password, row.password_hash)
    : (await verifyPassword(password, await getDummyHash()), false);
  if (!row || !ok) {
    await recordFailure(key);
    throw new AndonError(401, "아이디(사번·이메일) 또는 비밀번호가 올바르지 않습니다.", "INVALID_CREDENTIALS");
  }
  await clearFailures(key);
  const user = await getPublicUser(row.user_id);
  if (!user) throw new AndonError(401, "아이디(사번·이메일) 또는 비밀번호가 올바르지 않습니다.", "INVALID_CREDENTIALS");
  if (!user.active) throw new AndonError(403, "비활성(사용 중지)된 계정입니다. 관리자에게 문의하세요.", "ACCOUNT_INACTIVE");
  (await db.run("UPDATE user_identity SET last_login_at = ? WHERE provider = 'LOCAL' AND subject = ?", nowIso(), row.subject));
  return user;
}

// ---------------------------------------------------------------- sessions

export const SESSION_COOKIE = "andon_session";
const SESSION_TTL_MS = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 168)) * 3600_000;

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Always a NEW random token (prevents session fixation); only its hash is stored. */
export async function createSession(userId: number, audit: AuditInfo): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  (await db.run(`INSERT INTO user_session (token_hash, user_id, created_at, expires_at, last_seen_at, device_id, client_ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, sha256(token), userId, now.toISOString(), expiresAt.toISOString(), now.toISOString(), audit.deviceId, audit.clientIp, audit.userAgent));
  return { token, expiresAt };
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/**
 * The logged-in user of this request, resolved from the server on every call (current department,
 * role and active flag — a deactivated user is returned with active=false and cannot respond).
 */
export async function getSessionUser(req: Request): Promise<PublicUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const s = (await db.get("SELECT user_id, expires_at, last_seen_at FROM user_session WHERE token_hash = ? AND revoked_at IS NULL", sha256(token))) as { user_id: number; expires_at: string; last_seen_at: string } | undefined;
  if (!s || s.expires_at <= nowIso()) return null;
  // Touch at most every 5 minutes (dashboards poll constantly).
  if (Date.now() - new Date(s.last_seen_at).getTime() > 5 * 60_000) {
    (await db.run("UPDATE user_session SET last_seen_at = ? WHERE token_hash = ?", nowIso(), sha256(token)));
  }
  return getPublicUser(s.user_id);
}

export async function revokeSession(req: Request): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 100) return;
  (await db.run("UPDATE user_session SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", nowIso(), sha256(token)));
}

function secureCookie(req: Request): boolean {
  const mode = (process.env.COOKIE_SECURE || "auto").toLowerCase();
  if (mode === "true") return true;
  if (mode === "false") return false;
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}

/** HttpOnly + SameSite=Lax (+ Secure on HTTPS). Lax keeps the user logged in when opening a notification link. */
export function sessionCookie(req: Request, token: string, expiresAt: Date): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
    ...(secureCookie(req) ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(req: Request): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(secureCookie(req) ? ["Secure"] : [])].join("; ");
}

/**
 * Cross-site request guard for cookie-authenticated, state-changing requests: if the browser sends an
 * Origin header it must match the Host. (SameSite=Lax already blocks most cross-site POSTs.)
 */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    throw new AndonError(403, "허용되지 않은 요청입니다.", "BAD_ORIGIN");
  }
  if (host !== req.headers.get("host")) throw new AndonError(403, "허용되지 않은 요청입니다.", "BAD_ORIGIN");
}

// ---------------------------------------------------------------- password change

export interface PasswordChangeInput {
  currentPassword: unknown;
  newPassword: unknown;
  newPasswordConfirm: unknown;
}

/**
 * The logged-in user changes their own LOCAL password (e.g. after an administrator reset). The current
 * password is required and counts towards the login throttle. All OTHER sessions of the user are ended;
 * the session making the change stays logged in.
 */
export async function changePassword(req: Request, input: PasswordChangeInput, audit: AuditInfo): Promise<void> {
  const user = await getSessionUser(req);
  if (!user) throw new AndonError(401, "로그인이 필요합니다.", "AUTH_REQUIRED");
  if (!user.active) throw new AndonError(403, "비활성(사용 중지)된 계정입니다. 관리자에게 문의하세요.", "ACCOUNT_INACTIVE");
  const row = (await db.get("SELECT subject, password_hash FROM user_identity WHERE user_id = ? AND provider = 'LOCAL'", user.id)) as
    | { subject: string; password_hash: string | null }
    | undefined;
  if (!row?.password_hash) throw new AndonError(400, "이 계정에는 이메일·비밀번호 로그인이 없습니다.", "NO_LOCAL_LOGIN");

  const current = typeof input.currentPassword === "string" ? input.currentPassword : "";
  const next = typeof input.newPassword === "string" ? input.newPassword : "";
  const confirm = typeof input.newPasswordConfirm === "string" ? input.newPasswordConfirm : "";
  const key = throttleKey(row.subject, audit.clientIp);
  await assertNotLocked(key);
  if (!(await verifyPassword(current, row.password_hash))) {
    await recordFailure(key);
    throw new AndonError(400, "현재 비밀번호가 올바르지 않습니다.", "WRONG_CURRENT_PASSWORD");
  }
  await clearFailures(key);
  validatePassword(next);
  if (next !== confirm) throw new AndonError(400, "새 비밀번호 확인이 일치하지 않습니다.", "PASSWORD_MISMATCH");
  if (next === current) throw new AndonError(400, "현재 비밀번호와 다른 비밀번호를 입력하세요.", "SAME_PASSWORD");

  const hash = await hashPassword(next);
  const keep = sha256(readCookie(req, SESSION_COOKIE) ?? "");
  await db.transaction(async () => {
    await db.run("UPDATE user_identity SET password_hash = ? WHERE user_id = ? AND provider = 'LOCAL'", hash, user.id);
    await db.run("UPDATE user_session SET revoked_at = ? WHERE user_id = ? AND token_hash <> ? AND revoked_at IS NULL", nowIso(), user.id, keep);
  });
  console.info(`[auth] user #${user.id} changed password`);
}
