// Registration / login / session / authorization tests (npm run test:auth).
// Runs against a running server on THIS PC (BASE_URL, default http://localhost:3000): administrator
// steps use the masterdata CLI on the local database. Creates throw-away *@andon.test accounts and
// "[TEST] auth" ANDONs; closes the events and deactivates the accounts at the end.
import crypto from "node:crypto";
import { BASE, Client, admin, callerClient, check, createAndon, detail, finish, registerAccount, transition } from "./lib/testkit.ts";

const RUN = crypto.randomBytes(3).toString("hex");
const email = (k: string) => `a-${RUN}-${k}@andon.test`;
const PW = `Pw${crypto.randomBytes(6).toString("hex")}7`;
const reg = (c: Client, body: Record<string, unknown>) =>
  c.request("POST", "/api/auth/register", { name: `[TEST] auth ${RUN}`, department: "QC", password: PW, passwordConfirm: PW, ...body });
const login = (c: Client, e: string, p: string, headers: Record<string, string> = {}) =>
  c.request("POST", "/api/auth/login", { email: e, password: p }, headers);
const me = async (c: Client) => (await c.request("GET", "/api/auth/me")).body.user;

/** No password, hash or scrypt string may ever appear in an API response. */
function leaksSecret(raw: string, password: string) {
  return raw.includes(password) || /scrypt\$|password_?hash|passwordHash/i.test(raw);
}

async function main() {
  console.log(`Auth tests → ${BASE}`);
  const created: string[] = [];

  // ------------------------------------------------------------ REGISTRATION
  console.log("REGISTRATION");
  const c1 = new Client("reg1");
  const r1 = await reg(c1, { email: email("valid"), role: "PLANT_MANAGER", active: false, department: "QC" });
  check(r1.status === 201 && r1.body.user.departmentCode === "QC" && r1.body.user.active === true, `valid registration → 201, QC, active (${r1.status})`);
  check(r1.body.user.role === "RESPONDER", `role in body is ignored → RESPONDER (got ${r1.body.user.role}) — no privilege escalation`);
  check(!leaksSecret(r1.raw, PW), "registration response contains no password / hash");
  const cookie = r1.setCookie.find((c) => c.startsWith("andon_session=")) ?? "";
  check(/HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie) && /Path=\//.test(cookie), "session cookie is HttpOnly, SameSite=Lax, Path=/");
  check((await me(c1))?.email === email("valid"), "registered user is logged in (session resolves the user)");

  const dup = await reg(new Client("dup"), { email: `  ${email("valid").toUpperCase()} ` });
  check(dup.status === 409 && dup.body.code === "EMAIL_TAKEN", `duplicate email (case/whitespace variant) → 409 (${dup.status} ${dup.body.code})`);
  const race = await Promise.all([1, 2, 3, 4, 5].map((i) => reg(new Client(`race${i}`), { email: email("race") })));
  check(race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 4, `5 simultaneous registrations, same email → exactly one account (${race.map((r) => r.status).join(",")})`);
  const badEmail = await reg(new Client("x"), { email: "not-an-email" });
  check(badEmail.status === 400 && badEmail.body.code === "INVALID_EMAIL", `invalid email → 400 (${badEmail.body.code})`);
  const badDept = await reg(new Client("x"), { email: email("dept1"), department: "XYZ" });
  check(badDept.status === 400 && badDept.body.code === "INVALID_DEPARTMENT", `unknown department → 400 (${badDept.body.code})`);
  const legacyDept = await reg(new Client("x"), { email: email("dept2"), department: "QUALITY" });
  check(legacyDept.status === 400 && legacyDept.body.code === "INVALID_DEPARTMENT", `inactive pre-v3 department QUALITY → 400 (${legacyDept.body.code})`);
  const shortPw = await reg(new Client("x"), { email: email("pw1"), password: "Ab1", passwordConfirm: "Ab1" });
  check(shortPw.status === 400 && shortPw.body.code === "INVALID_PASSWORD", `password too short → 400 (${shortPw.body.code})`);
  const noDigit = await reg(new Client("x"), { email: email("pw2"), password: "abcdefghij", passwordConfirm: "abcdefghij" });
  check(noDigit.status === 400 && noDigit.body.code === "INVALID_PASSWORD", `password without digit → 400 (${noDigit.body.code})`);
  const mismatch = await reg(new Client("x"), { email: email("pw3"), passwordConfirm: `${PW}x` });
  check(mismatch.status === 400 && mismatch.body.code === "PASSWORD_MISMATCH", `password confirmation mismatch → 400 (${mismatch.body.code})`);
  const noName = await reg(new Client("x"), { email: email("name"), name: "   " });
  check(noName.status === 400 && noName.body.code === "INVALID_NAME", `empty name → 400 (${noName.body.code})`);

  // ------------------------------------------------------------ LOGIN / SESSION
  console.log("LOGIN / SESSION");
  const c2 = new Client("login");
  const ok = await login(c2, email("valid"), PW);
  check(ok.status === 200 && ok.body.user.email === email("valid") && !leaksSecret(ok.raw, PW), `valid login → 200, no secrets in response (${ok.status})`);
  check((await c2.request("GET", "/api/auth/me")).raw.match(/scrypt|password/i) === null, "/api/auth/me contains no password / hash");
  const wrong = await login(new Client("x"), email("valid"), `${PW}wrong`);
  const unknown = await login(new Client("x"), email("nobody"), PW);
  check(wrong.status === 401 && wrong.body.code === "INVALID_CREDENTIALS", `wrong password → 401 (${wrong.status})`);
  check(unknown.status === 401 && unknown.body.error === wrong.body.error, "unknown user → 401 with the same message (no account enumeration)");

  // session fixation: a cookie chosen before login must not become the session
  const fix = new Client("fixation");
  fix.cookie = "andon_session=attacker-chosen-token-123";
  await login(fix, email("valid"), PW);
  check(!!fix.cookie && fix.cookie !== "andon_session=attacker-chosen-token-123", "login issues a NEW session token (no fixation)");
  const attacker = new Client("attacker");
  attacker.cookie = "andon_session=attacker-chosen-token-123";
  check((await me(attacker)) === null, "attacker's pre-set token is not a valid session");

  // logout + replay of the old cookie
  const c3 = new Client("logout");
  await login(c3, email("valid"), PW);
  const oldCookie = c3.cookie;
  const out = await c3.request("POST", "/api/auth/logout");
  check(out.status === 200 && c3.cookie === null && (await me(c3)) === null, "logout clears the session");
  const replay = new Client("replay");
  replay.cookie = oldCookie;
  check((await me(replay)) === null, "old session cookie no longer works after logout (server-side revocation)");
  const forged = new Client("forged");
  forged.cookie = `andon_session=${crypto.randomBytes(32).toString("base64url")}`;
  check((await me(forged)) === null, "invalid / unknown session token → not logged in");

  // password change (own account, from the session)
  const pwAcc = await registerAccount("QC", "auth-pwchange");
  const pwA = new Client("pw-a");
  const pwB = new Client("pw-b");
  await login(pwA, pwAcc.email, pwAcc.password);
  await login(pwB, pwAcc.email, pwAcc.password);
  const NEWPW = `Nw${crypto.randomBytes(6).toString("hex")}8`;
  const chg = (c: Client, body: Record<string, unknown>, headers: Record<string, string> = {}) => c.request("POST", "/api/auth/password", body, headers);
  const good = { currentPassword: pwAcc.password, newPassword: NEWPW, newPasswordConfirm: NEWPW };
  check((await chg(new Client("anon"), good)).status === 401, "password change without login → 401");
  const pwEvil = await chg(pwA, good, { origin: "http://evil.example" });
  check(pwEvil.status === 403 && pwEvil.body.code === "BAD_ORIGIN", `password change from a foreign Origin → 403 (${pwEvil.body.code})`);
  const pwWrong = await chg(pwA, { ...good, currentPassword: "wrongpass1" });
  check(pwWrong.status === 400 && pwWrong.body.code === "WRONG_CURRENT_PASSWORD", `wrong current password → 400 (${pwWrong.body.code})`);
  const pwWeak = await chg(pwA, { ...good, newPassword: "short1", newPasswordConfirm: "short1" });
  check(pwWeak.status === 400 && pwWeak.body.code === "INVALID_PASSWORD", `weak new password → 400 (${pwWeak.body.code})`);
  const pwMis = await chg(pwA, { ...good, newPasswordConfirm: `${NEWPW}x` });
  check(pwMis.status === 400 && pwMis.body.code === "PASSWORD_MISMATCH", `new password confirmation mismatch → 400 (${pwMis.body.code})`);
  const pwSame = await chg(pwA, { ...good, newPassword: pwAcc.password, newPasswordConfirm: pwAcc.password });
  check(pwSame.status === 400 && pwSame.body.code === "SAME_PASSWORD", `new = current password → 400 (${pwSame.body.code})`);
  const pwOk = await chg(pwA, good);
  check(pwOk.status === 200 && !leaksSecret(pwOk.raw, NEWPW) && !pwOk.raw.includes(pwAcc.password), `password changed → 200, no secrets in response (${pwOk.status})`);
  check((await me(pwA))?.email === pwAcc.email && (await me(pwB)) === null, "after the change: this session stays logged in, the other session is ended");
  check((await login(new Client("x"), pwAcc.email, pwAcc.password)).status === 401 && (await login(new Client("x"), pwAcc.email, NEWPW)).status === 200, "old password rejected, new password accepted");

  const evil = await login(new Client("csrf"), email("valid"), PW, { origin: "http://evil.example" });
  check(evil.status === 403 && evil.body.code === "BAD_ORIGIN", `cross-site login request (foreign Origin) → 403 (${evil.status})`);

  // inactive account
  const inact = await registerAccount("QC", "auth-inactive");
  admin("user", "deactivate", inact.email);
  const inactLogin = await login(new Client("x"), inact.email, inact.password);
  check(inactLogin.status === 403 && inactLogin.body.code === "ACCOUNT_INACTIVE", `inactive user cannot log in → 403 (${inactLogin.body.code})`);

  // brute-force throttle (own e-mail, so other tests are not affected)
  const victim = await registerAccount("MT", "auth-throttle");
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push((await login(new Client("bf"), victim.email, "wrongpass1")).status);
  check(tries.slice(0, 5).every((s) => s === 401) && tries[5] === 429, `6th wrong password within 15 min → 429 (${tries.join(",")})`);

  // ------------------------------------------------------------ AUTHORIZATION & ROUTING
  console.log("AUTHORIZATION & ROUTING");
  const qc = await registerAccount("QC", "auth-qc");
  const mt = await registerAccount("MT", "auth-mt");
  const pcl = await registerAccount("PCL", "auth-pcl");
  const ev = async (category: string, label: string) => {
    const r = await createAndon("TGDI2", "Leak Test", category, `[TEST] auth: ${label}`);
    created.push(r.body.event.id);
    return r.body.event as { id: string; departmentCode: string };
  };
  const qEv = await ev("QUALITY", "QC event");
  const mEv = await ev("MAINTENANCE", "MT event");
  const lEv = await ev("MATERIAL", "PC&L event");
  const eligible = async (id: string) => ((await detail(id)).body.eligibleResponders as { id: number }[]).map((u) => u.id);
  check((await eligible(qEv.id)).includes(qc.id), "newly registered QC responder is automatically eligible for a QUALITY → QC event");
  check((await eligible(mEv.id)).includes(mt.id) && !(await eligible(mEv.id)).includes(qc.id), "newly registered MT responder is eligible for MAINTENANCE → MT (QC is not)");
  check(lEv.departmentCode === "PCL" && (await eligible(lEv.id)).includes(pcl.id), `MATERIAL → PCL; registered PC&L responder eligible (dept ${lEv.departmentCode})`);
  check((await me(pcl.client)).departmentLabel === "PC&L · 물류", "PCL user is shown as PC&L · 물류");

  const qcOnMt = await transition(qc.client, mEv.id, "ACKNOWLEDGE");
  check(qcOnMt.status === 403 && qcOnMt.body.code === "WRONG_DEPARTMENT", `QC responder cannot ACK an MT event → 403 (${qcOnMt.body.code})`);
  const spoof = await transition(qc.client, mEv.id, "ACKNOWLEDGE", undefined, { userId: mt.id });
  check(spoof.status === 400 && spoof.body.code === "RESPONDER_MISMATCH", `QC session + MT user id in body → rejected (${spoof.body.code})`);
  const anon = await transition(new Client("anon"), qEv.id, "ACKNOWLEDGE", undefined, { userId: qc.id });
  check(anon.status === 401, `no session (identity only in body) → 401 (${anon.status})`);

  const qcAck = await transition(qc.client, qEv.id, "ACKNOWLEDGE");
  check(qcAck.status === 200 && qcAck.body.event.status === "ACKNOWLEDGED", `logged-in QC responder ACKs QC event (${qcAck.status})`);
  const row = qcAck.body.transitions.at(-1);
  check(row.userId === qc.id && row.userName === qc.name && row.userDepartment === "QC" && row.userRole === "RESPONDER", "audit: user id / name / department / role recorded");
  check(row.deviceId === qc.client.device && !!row.clientIp && row.userAgent === `andon-test/${qc.client.label}`, "audit: device id / IP / user agent recorded");
  const pclAck = await transition(pcl.client, lEv.id, "ACKNOWLEDGE");
  check(pclAck.status === 200 && pclAck.body.transitions.at(-1).userDepartment === "PCL", "PC&L responder ACKs PCL event (internal code PCL)");

  // deactivated AFTER login: the existing session can no longer act
  admin("user", "deactivate", qc.email);
  const deact = await transition(qc.client, qEv.id, "ACTION", "[TEST] should be rejected");
  check(deact.status === 403 && deact.body.code === "INACTIVE_RESPONDER", `user deactivated after login → 403 (${deact.body.code})`);
  check((await me(qc.client))?.active === false, "/api/auth/me shows the account as inactive");
  admin("user", "activate", qc.email);

  // role change by administrator takes effect immediately
  admin("user", "role", mt.email, "OPERATOR");
  const op = await transition(mt.client, mEv.id, "ACKNOWLEDGE");
  check(op.status === 403 && op.body.code === "ROLE_NOT_ALLOWED", `OPERATOR role cannot ACK → 403 (${op.body.code})`);
  admin("user", "role", mt.email, "RESPONDER");

  // department change by administrator: eligibility follows the department
  admin("user", "dept", qc.email, "MT");
  check((await eligible(mEv.id)).includes(qc.id) && !(await eligible(qEv.id)).includes(qc.id), "after admin moves the user QC → MT, eligibility follows (MT yes, QC no)");
  admin("user", "dept", qc.email, "QC");

  // ------------------------------------------------------------ cleanup: close the events
  const closers: Record<string, Client> = { QC: qc.client, MT: mt.client, PCL: pcl.client };
  const uapCloser = await callerClient(); // a QC event is closed by UAP (plant meeting 2026-10-07)
  for (const id of created) {
    const d = (await detail(id)).body;
    const c = closers[d.responsibility.effectiveDepartmentCode];
    if (d.event.status === "OPEN") await transition(c, id, "ACKNOWLEDGE");
    await transition(d.responsibility.effectiveDepartmentCode === "QC" ? uapCloser : c, id, "CLOSE", "[TEST] auth test cleanup");
  }
  const open = (await fetch(`${BASE}/api/andons?scope=active`).then((r) => r.json())).events.filter((e: { id: string }) => created.includes(e.id));
  check(open.length === 0, `test events closed again (${created.length})`);
}

main()
  .then(() => finish())
  .catch((err) => {
    console.error("Test aborted:", err);
    process.exit(1);
  });
