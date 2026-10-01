import * as oidc from 'openid-client';
import crypto from 'node:crypto';
import { authenticate, createSession, getSessionUser, readCookie, revokeSession, sessionCookie, SESSION_COOKIE } from './auth.ts';
import { db, nowIso } from './db.ts';
import { AndonError } from './errors.ts';
import { requestAudit } from './http.ts';
import { addGoogleIdentity, requireActiveUser, resolveGoogleIdentity, type EmployeeProfile, type GoogleIdentity } from './googleIdentity.ts';

const COOKIE = 'andon_google_flow';
const CALLBACK = '/api/auth/google/callback';
const TTL = 10 * 60_000;
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
type Flow = { token_hash: string; phase: string; state: string; nonce: string; verifier: string; next_path: string;
  link_user_id: number | null; link_session_hash: string | null; subject: string; provider_email: string; display_name: string; expires_at: string };

export function googleSettings() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirect = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !secret || !redirect) throw new AndonError(503, 'Google 로그인이 아직 설정되지 않았습니다. 로컬 로그인을 이용하세요.', 'GOOGLE_NOT_CONFIGURED');
  const url = new URL(redirect);
  if (url.pathname !== CALLBACK || url.search || url.hash || url.username || url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
    throw new AndonError(503, 'Google redirect URI 설정을 확인하세요.', 'GOOGLE_BAD_CONFIG');
  if (url.protocol === 'https:' && process.env.COOKIE_SECURE === 'false')
    throw new AndonError(503, 'HTTPS에서는 Secure 쿠키를 활성화하세요.', 'GOOGLE_BAD_CONFIG');
  return { clientId, secret, redirect: url.href, origin: url.origin, secure: url.protocol === 'https:' };
}

/** True when Google login is fully configured. Reveals nothing else (used to show/hide the button). */
export function googleConfigured(): boolean {
  try { googleSettings(); return true; } catch { return false; }
}

export function safeGoogleNext(value: unknown) {
  if (typeof value !== 'string' || value.length > 1000 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return '/respond';
  // Restrict to actual post-login application destinations, never another redirect endpoint.
  const url = new URL(value, 'https://andon.invalid');
  if (url.origin !== 'https://andon.invalid' || !/^\/(respond(?:\/AND-\d{8}-\d+)?|me|dashboard|history|operator)$/.test(url.pathname)) return '/respond';
  return url.pathname + url.search + url.hash;
}

let configuration: Promise<oidc.Configuration> | undefined;
async function config() {
  const settings = googleSettings();
  configuration ??= oidc.discovery(new URL('https://accounts.google.com'), settings.clientId, settings.secret,
    undefined, { timeout: 10, execute: [oidc.enableNonRepudiationChecks] }).catch(() => {
      configuration = undefined;
      throw new AndonError(503, 'Google 인증 서버에 연결할 수 없습니다. 다시 시도하세요.', 'GOOGLE_UNAVAILABLE');
    });
  return configuration;
}

function flowCookie(token: string, clear = false) {
  return `${COOKIE}=${token}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : TTL / 1000}${googleSettings().secure ? '; Secure' : ''}`;
}
function flowToken(req: Request) { const t = readCookie(req, COOKIE); return t && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null; }
function sessionHash(req: Request) { return hash(readCookie(req, SESSION_COOKIE) ?? ''); }

export function assertGoogleOrigin(req: Request) {
  if (req.headers.get('origin') !== googleSettings().origin) throw new AndonError(403, '허용되지 않은 요청입니다.', 'BAD_ORIGIN');
}

export async function beginGoogle(req: Request, input: { next?: unknown; mode?: unknown; password?: unknown }) {
  assertGoogleOrigin(req);
  let linkUserId: number | null = null;
  if (input.mode === 'link') {
    const user = await getSessionUser(req);
    if (!user || !user.active || !user.email) throw new AndonError(401, '기존 로컬 계정으로 로그인하세요.', 'AUTH_REQUIRED');
    const verified = await authenticate(user.email, input.password, requestAudit(req));
    if (verified.id !== user.id) throw new AndonError(403, '연결 계정을 확인하세요.', 'LINK_MISMATCH');
    linkUserId = user.id;
  }
  const cfg = await config();
  const token = crypto.randomBytes(32).toString('base64url');
  const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
  const url = oidc.buildAuthorizationUrl(cfg, { redirect_uri: googleSettings().redirect, scope: 'openid email profile',
    state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', prompt: 'select_account' });
  await db.transaction(async () => {
    (await db.run('DELETE FROM google_auth_flow WHERE expires_at <= ? OR token_hash = ?', nowIso(), hash(flowToken(req) ?? '')));
    (await db.run(`INSERT INTO google_auth_flow(token_hash,phase,state,nonce,verifier,next_path,link_user_id,link_session_hash,expires_at)
      VALUES (?,'AUTHORIZATION',?,?,?,?,?,?,?)`, hash(token),state,nonce,verifier,safeGoogleNext(input.next),linkUserId,linkUserId ? sessionHash(req) : null,new Date(Date.now()+TTL).toISOString()));
  });
  return Response.json({ url: url.href }, { headers: { 'Set-Cookie': flowCookie(token), 'Cache-Control': 'no-store' } });
}

async function assertLinkSession(req: Request, flow: Flow) {
  if (flow.link_user_id === null) return;
  const user = await getSessionUser(req);
  if (!user || user.id !== flow.link_user_id || !user.active || sessionHash(req) !== flow.link_session_hash)
    throw new AndonError(403, '연결을 시작한 계정으로 다시 로그인하세요.', 'LINK_SESSION_CHANGED');
}

export async function takeAuthorizationFlow(req: Request) {
  const token = flowToken(req), params = new URL(req.url).searchParams;
  if (!token || params.getAll('state').length !== 1) throw new AndonError(400, '인증 요청이 만료되었거나 일치하지 않습니다.', 'GOOGLE_INVALID_STATE');
  const row = (await db.get(`DELETE FROM google_auth_flow WHERE token_hash=? AND phase='AUTHORIZATION' AND state=? AND expires_at>? RETURNING *`, hash(token),params.get('state')!,nowIso())) as unknown as Flow | undefined;
  if (!row) throw new AndonError(400, '인증 요청이 만료되었거나 일치하지 않습니다.', 'GOOGLE_INVALID_STATE');
  await assertLinkSession(req,row);
  return row;
}

export async function exchangeGoogleCode(cfg: oidc.Configuration, url: URL, flow: Pick<Flow,'state'|'nonce'|'verifier'>): Promise<GoogleIdentity> {
  // Library validates issuer, audience, expiry, nonce, state, PKCE and (enabled above) JWK signature.
  const tokens = await oidc.authorizationCodeGrant(cfg,url,{expectedState:flow.state,expectedNonce:flow.nonce,pkceCodeVerifier:flow.verifier,idTokenExpected:true});
  const claims = tokens.claims();
  if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || claims.email_verified !== true || typeof claims.email !== 'string' || claims.email.length > 254)
    throw new AndonError(400, 'Google 신원 정보를 확인할 수 없습니다.', 'GOOGLE_INVALID_IDENTITY');
  return {subject:claims.sub,email:claims.email,name:typeof claims.name === 'string' ? claims.name.slice(0,40) : ''};
}

export async function sessionResponse(req: Request, userId: number, next: string, redirect = false) {
  await requireActiveUser(userId);
  await revokeSession(req);
  const session = await createSession(userId,requestAudit(req));
  const headers = new Headers({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  const cookie = sessionCookie(req,session.token,session.expiresAt);
  headers.append('Set-Cookie',cookie + (googleSettings().secure && !/; Secure(?:;|$)/i.test(cookie) ? '; Secure' : ''));
  headers.append('Set-Cookie',flowCookie('',true));
  if (redirect) { headers.set('Location',new URL(safeGoogleNext(next),googleSettings().origin).href); return new Response(null,{status:303,headers}); }
  return Response.json({next:safeGoogleNext(next)},{headers});
}

export async function completeGoogleCallback(req: Request) {
  const settings = googleSettings();
  // Ignore attacker-controlled Host/X-Forwarded-Host for redirect and token exchange destinations.
  if (req.headers.get('host') !== new URL(settings.redirect).host || new URL(req.url).pathname !== CALLBACK)
    throw new AndonError(400,'콜백 주소가 일치하지 않습니다.','GOOGLE_BAD_CALLBACK');
  const flow = await takeAuthorizationFlow(req);
  const callback = new URL(settings.redirect); callback.search = new URL(req.url).search;
  const identity = await exchangeGoogleCode(await config(),callback,flow);
  const user = await resolveGoogleIdentity(identity);
  if (user && flow.link_user_id !== null && user.id !== flow.link_user_id) throw new AndonError(409,'이미 다른 직원에게 연결된 Google 계정입니다.','GOOGLE_IDENTITY_TAKEN');
  if (user) return sessionResponse(req,user.id,flow.next_path,true);
  const token = crypto.randomBytes(32).toString('base64url');
  (await db.run(`INSERT INTO google_auth_flow(token_hash,phase,next_path,link_user_id,link_session_hash,subject,provider_email,display_name,expires_at)
    VALUES (?,'ONBOARDING',?,?,?,?,?,?,?)`, hash(token),flow.next_path,flow.link_user_id,flow.link_session_hash,identity.subject,identity.email,identity.name,new Date(Date.now()+TTL).toISOString()));
  return new Response(null,{status:303,headers:{Location:new URL('/onboarding',settings.origin).href,'Set-Cookie':flowCookie(token),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}

async function pendingFlow(req: Request) {
  const token = flowToken(req);
  const row = token ? (await db.get("SELECT * FROM google_auth_flow WHERE token_hash=? AND phase='ONBOARDING' AND expires_at>?", hash(token),nowIso())) as unknown as Flow | undefined : undefined;
  if (!row) throw new AndonError(401,'Google 인증 후 다시 시작하세요. 등록 유효시간이 만료되었습니다.','GOOGLE_ONBOARDING_REQUIRED');
  await assertLinkSession(req,row);
  return row;
}

export async function onboardingInfo(req: Request) {
  const flow = await pendingFlow(req);
  const employee = flow.link_user_id === null ? null : (await db.get('SELECT employee_id,name,phone,kakao_id,company_email,department_code,role FROM app_user WHERE id=?', flow.link_user_id));
  return {email:flow.provider_email,name:flow.display_name,linking:flow.link_user_id!==null,employee};
}

export async function finishGoogleOnboarding(req: Request, input: EmployeeProfile) {
  assertGoogleOrigin(req);
  let result: { user: { id: number }; next: string };
  try {
    result = await db.transaction(async () => {
      const flow = await pendingFlow(req);
      const user = await addGoogleIdentity({subject:flow.subject,email:flow.provider_email,name:flow.display_name},input,flow.link_user_id);
      (await db.run('DELETE FROM google_auth_flow WHERE token_hash=?', flow.token_hash));
      return {user,next:flow.next_path};
    });
  } catch (err) {
    // Unique indexes are the final guard when two onboardings race for the same employee ID / Google account.
    if (!(err instanceof AndonError) && /UNIQUE constraint failed/.test(String((err as Error)?.message))) {
      throw /employee_id/.test(String((err as Error).message))
        ? new AndonError(409, '이미 등록된 사번입니다. 관리자에게 문의하세요.', 'EMPLOYEE_ID_TAKEN')
        : new AndonError(409, '이미 연결된 Google 계정입니다. 다시 로그인하세요.', 'GOOGLE_IDENTITY_TAKEN');
    }
    throw err;
  }
  return sessionResponse(req,result.user.id,result.next);
}

/** Do not log OIDC exception objects: they may contain codes, tokens or client credentials. */
export async function googleHandle(fn: () => Response | Promise<Response>) {
  try { return await fn(); } catch (err) {
    const known = err instanceof AndonError;
    // Error class + library error code only (e.g. OAUTH_JWT_CLAIM_COMPARISON_FAILED) — never messages,
    // causes or objects, which can contain authorization codes, tokens or client credentials.
    const libCode = (err as { code?: unknown })?.code;
    const detail = known ? err.code : `${(err as Error)?.name ?? 'Error'}${typeof libCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(libCode) ? ':' + libCode : ''}`;
    console.warn('[google-auth]', known ? err.code : 'GOOGLE_AUTH_FAILED', known ? '' : detail);
    return Response.json({error:known ? err.message : 'Google 인증에 실패했습니다. 로그인 화면에서 다시 시도하세요.',code:known ? err.code : 'GOOGLE_AUTH_FAILED'},
      {status:known ? err.status : 400,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }
}
