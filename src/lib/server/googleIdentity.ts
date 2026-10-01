// Only server-verified OIDC claims may enter this module. Never accept claims from request JSON.
import { DEPARTMENT_CODES, SELF_REGISTRATION_ROLE } from '../domain.ts';
import { getPublicUser } from './auth.ts';
import { getDb, nowIso, transaction } from './db.ts';
import { AndonError } from './errors.ts';

export interface GoogleIdentity { subject: string; email: string; name: string }
export interface EmployeeProfile { employeeId?: unknown; name?: unknown; department?: unknown; phone?: unknown; kakaoId?: unknown; companyEmail?: unknown }

export function requireActiveUser(id: number) {
  const user = getPublicUser(id);
  if (!user || !user.active) throw new AndonError(403, '비활성 계정입니다. 관리자에게 문의하세요.', 'ACCOUNT_INACTIVE');
  return user;
}

/** Subject alone identifies the employee; email changes only update provider metadata. */
export function resolveGoogleIdentity(identity: GoogleIdentity) {
  const db = getDb();
  const row = db.prepare("SELECT user_id FROM user_identity WHERE provider = 'GOOGLE' AND subject = ?").get(identity.subject);
  if (!row) return null;
  const user = requireActiveUser(Number(row.user_id));
  db.prepare("UPDATE user_identity SET provider_email = ?, last_login_at = ? WHERE provider = 'GOOGLE' AND subject = ?")
    .run(identity.email, nowIso(), identity.subject);
  return user;
}

function profile(input: EmployeeProfile) {
  const employeeId = String(input.employeeId ?? '').trim().toUpperCase();
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  const phone = String(input.phone ?? '').trim().replace(/[ ()-]/g, '');
  const kakaoId = String(input.kakaoId ?? '').trim();
  const companyEmail = String(input.companyEmail ?? '').trim().toLowerCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(employeeId)) throw new AndonError(400, '사번은 영문/숫자/하이픈/밑줄 2~40자로 입력하세요.', 'INVALID_EMPLOYEE_ID');
  if (!name || name.length > 40 || /[\u0000-\u001f<>]/.test(name)) throw new AndonError(400, '이름을 1~40자로 입력하세요.', 'INVALID_NAME');
  if (!/^\+?[0-9]{8,15}$/.test(phone)) throw new AndonError(400, '휴대전화 번호를 확인하세요.', 'INVALID_PHONE');
  if (!kakaoId || kakaoId.length > 100 || /[\u0000-\u001f<>]/.test(kakaoId)) throw new AndonError(400, '카카오톡 ID를 1~100자로 입력하세요.', 'INVALID_KAKAO_ID');
  if (companyEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(companyEmail) || companyEmail.length > 254)) throw new AndonError(400, '회사 이메일 형식을 확인하세요.', 'INVALID_EMAIL');
  return { employeeId, name, phone, kakaoId, companyEmail: companyEmail || null };
}

/** Caller holds a transaction. Link only to a reauthenticated, session-bound employee. */
export function addGoogleIdentity(identity: GoogleIdentity, input: EmployeeProfile, linkUserId: number | null) {
  const db = getDb();
  const p = profile(input);
  if (db.prepare("SELECT 1 FROM user_identity WHERE provider='GOOGLE' AND subject=?").get(identity.subject))
    throw new AndonError(409, '이미 연결된 Google 계정입니다. 다시 로그인하세요.', 'GOOGLE_IDENTITY_TAKEN');
  const owner = db.prepare('SELECT id FROM app_user WHERE employee_id=?').get(p.employeeId);
  if (owner && owner.id !== linkUserId) throw new AndonError(409, '이미 등록된 사번입니다. 기존 계정으로 로그인 후 Google을 연결하거나 관리자에게 문의하세요.', 'EMPLOYEE_ID_TAKEN');
  let userId: number;
  if (linkUserId !== null) {
    requireActiveUser(linkUserId);
    const old = db.prepare('SELECT employee_id FROM app_user WHERE id=?').get(linkUserId)!;
    if (old.employee_id && old.employee_id !== p.employeeId) throw new AndonError(409, '기존 사번은 변경할 수 없습니다.', 'EMPLOYEE_ID_IMMUTABLE');
    if (db.prepare("SELECT 1 FROM user_identity WHERE provider='GOOGLE' AND user_id=?").get(linkUserId))
      throw new AndonError(409, '이 직원에게 이미 Google 계정이 연결되어 있습니다.', 'EMPLOYEE_GOOGLE_TAKEN');
    // Identity, department, role, active, local email/password and historical names stay unchanged.
    db.prepare('UPDATE app_user SET employee_id=?, phone=?, kakao_id=?, company_email=? WHERE id=?')
      .run(p.employeeId, p.phone, p.kakaoId, p.companyEmail, linkUserId);
    userId = linkUserId;
  } else {
    // Never infer an existing employee from a Google email, company email or a name.
    const department = String(input.department ?? '');
    if (!(DEPARTMENT_CODES as readonly string[]).includes(department) || !db.prepare('SELECT 1 FROM department WHERE code=? AND active=1').get(department))
      throw new AndonError(400, '활성 부서를 목록에서 선택하세요.', 'INVALID_DEPARTMENT');
    userId = Number(db.prepare(`INSERT INTO app_user (name,employee_id,phone,kakao_id,company_email,department_code,role,active,source,created_at)
      VALUES (?,?,?,?,?,?,?,1,'REGISTRATION',?)`).run(p.name,p.employeeId,p.phone,p.kakaoId,p.companyEmail,department,SELF_REGISTRATION_ROLE,nowIso()).lastInsertRowid);
  }
  db.prepare("INSERT INTO user_identity(user_id,provider,subject,provider_email,created_at,last_login_at) VALUES (?,'GOOGLE',?,?,?,?)")
    .run(userId, identity.subject, identity.email, nowIso(), nowIso());
  return requireActiveUser(userId);
}

// Useful for administrator/test callers; browser onboarding uses the flow's enclosing transaction.
export function registerGoogleEmployee(identity: GoogleIdentity, input: EmployeeProfile, linkUserId: number | null = null) {
  return transaction(getDb(), () => addGoogleIdentity(identity, input, linkUserId));
}
