// Account import tests (npm run test:accounts). Fresh isolated database under work/accounts-test/,
// fake names and *.test e-mails only. Never Turso.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve("work/accounts-test", `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`);
fs.mkdirSync(DIR, { recursive: true });
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.DATABASE_PATH = path.join(DIR, "accounts.db");
process.env.UPLOAD_DIR = path.join(DIR, "uploads");
delete process.env.ALLOW_SELF_REGISTRATION; // production default: closed

const { db, nowIso } = await import("../src/lib/server/db.ts");
const { applyOrgImport } = await import("../src/lib/server/lineAssignments.ts");
const { authenticate, registerUser } = await import("../src/lib/server/auth.ts");
const identity = await import("../src/lib/server/googleIdentity.ts");
const acc = await import("./lib/account-import.ts");

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`  ${cond ? "✔" : "✖"} ${label}`);
  if (!cond) failures++;
};
const audit = { deviceId: null, clientIp: "127.0.0.1", userAgent: "accounts-test" };

await applyOrgImport([{ lineName: "Main #1", uapAreaCode: "AP-1", supervisor: "감독자-T", gapLeaders: { A: "리더-TA", B: "리더-TB" } }], "test");
await db.run("INSERT INTO app_user (name, department_code, role, active, source, created_at) VALUES ('물류-T', 'PCL', 'RESPONDER', 1, 'ADMIN', ?)", nowIso());

const csv = [
  "이름,부서,직급,연락처,Kakao Talk ID,로그인 이메일,기본알림",
  "리더-TA(A),UAP,GL,010-0000-0000,kakao-x,gl-a@andon.test",
  "감독자-T,AP-1,SV,,,sv@andon.test",
  "리더-없음,UAP,GL,,,nobody@andon.test",
  "보전-T,보전,책임,,,mt1@andon.test",
  "보전팀장-T,MT,팀장,,,mt-lead@andon.test",
  "물류-T,PC&L,담당,,,pcl@andon.test",
  "중복-T,QC,책임,,,mt1@andon.test",
  "잘못-T,QC,책임,,,not-an-email",
  "부서-T,총무,책임,,,x@andon.test",
  "생산팀장-T,UAP,팀장,,,uap-lead@andon.test",
  "생산책임-T,UAP,책임,,,uap-staff@andon.test,Y",
  "공장장-T,,PM,,,pm@andon.test",
].join("\n");
const file = path.join(DIR, "accounts.csv");
fs.writeFileSync(file, "﻿" + csv);

console.log("Account import (isolated DB)");
const rows = await acc.readAccountFile(file);
check(rows.length === 12 && rows[0].name === "리더-TA", `reads 12 rows, "(A)" removed from names (${rows.length})`);
check(!JSON.stringify(rows).includes("010-0000-0000") && !JSON.stringify(rows).includes("kakao-x"), "phone / KakaoTalk columns are not read");

const res = await acc.importAccounts(rows);
check(res.loginAdded === 3 && res.created === 6, `GL + SV + existing PC&L get a login; 2 MT, 부서-T, UAP 팀장, UAP 책임, PM created (added ${res.loginAdded}, created ${res.created})`);
const flag = async (n: string) => (await db.get("SELECT role, department_code d, team_leader t, call_default c FROM app_user WHERE name = ?", n))!;
check((await flag("보전팀장-T")).t === 1 && (await flag("보전팀장-T")).c === 0, "MT 팀장 → team leader (escalation), not a default recipient");
check((await flag("생산팀장-T")).t === 1 && (await flag("생산팀장-T")).c === 1, "UAP 팀장 → team leader + default recipient of QC / MT calls");
check((await flag("생산책임-T")).t === 0 && (await flag("생산책임-T")).c === 1, "기본알림 Y → default recipient");
check((await flag("공장장-T")).role === "PLANT_MANAGER" && (await flag("공장장-T")).d === "UAP", "PM without department → PLANT_MANAGER in UAP");
const gl = await db.get("SELECT u.id, u.role, i.subject FROM app_user u JOIN user_identity i ON i.user_id = u.id WHERE u.name = '리더-TA'");
check(gl?.role === "GAP_LEADER" && gl?.subject === "gl-a@andon.test", "GAP leader login is on the line-ownership employee (no duplicate person)");
check(Number((await db.get("SELECT COUNT(*) n FROM app_user WHERE name = '리더-TA'"))!.n) === 1, "still one record for the GAP leader");
const lines = await db.all("SELECT line_code FROM line_assignment WHERE user_id = ? AND active = 1", gl!.id as number);
check(lines.length === 1, "the GAP leader keeps the line assignment (my lines work after login)");
check((await db.get("SELECT department_code d, role FROM app_user WHERE name = '보전팀장-T'"))?.d === "MT", "team leader created in MT (as RESPONDER — receives MT messages)");
check(res.problems.some((p) => p.includes("리더-없음") && p.includes("not in the line-ownership")), "GL not in the ownership list → reported, not created");
check(!(await db.get("SELECT 1 FROM app_user WHERE name = '리더-없음'")), "… and no account was created for it");
check(res.problems.some((p) => p.includes("중복-T")), "duplicate login e-mail in the file → reported");
check(res.problems.some((p) => p.includes("잘못-T")), "invalid e-mail → reported");
check(res.problems.some((p) => p.includes("부서-T") && p.includes("not a department name")), "text that is not a department (QC sub-role, 총무 …) → department of the rows above, reported for checking");
const login = await authenticate("gl-a@andon.test", res.credentials.find((c) => c.loginId === "gl-a@andon.test")!.temporaryPassword, audit);
check(login.role === "GAP_LEADER", "the temporary password works for login");

const again = await acc.importAccounts(rows);
check(again.created === 0 && again.loginAdded === 0 && again.unchanged === 9, `repeat import changes nothing (unchanged ${again.unchanged})`);

const out = acc.writeCredentials(DIR, res.credentials);
const text = fs.readFileSync(out, "utf8");
check(text.split("\r\n").length === 10 && text.includes("임시 비밀번호"), "credentials file: header + 9 rows");
const stored = JSON.stringify(await db.all("SELECT * FROM app_user")) + JSON.stringify(await db.all("SELECT * FROM user_identity"));
check(!res.credentials.some((c) => stored.includes(c.temporaryPassword)), "temporary passwords are not stored in plain text");

console.log("Login by 사번 (employee number)");
const csv2 = ["이름,부서,부서-1,직급,사번,Google ID,Kakao Talk ID,연락처,FORVIA E-mail", "리더-TB(B),,AP-1,GL,10002002,g-x,k-x,010-1111-2222,", "보전2-T,Mt,Mt,책임,10003003,,,,mt2@forvia.test", "선임-T,PC&L,PC&L,선임,,g-y,k-y,,"].join("\n");
const file2 = path.join(DIR, "accounts2.csv");
fs.writeFileSync(file2, "﻿" + csv2);
const rows2 = await acc.readAccountFile(file2);
check(!JSON.stringify(rows2).includes("010-1111-2222") && !JSON.stringify(rows2).includes("g-x") && !JSON.stringify(rows2).includes("k-x"), "phone / Google ID / KakaoTalk ID columns are not read");
const res2 = await acc.importAccounts(rows2);
const glB = await db.get("SELECT u.employee_id, u.email, i.subject FROM app_user u JOIN user_identity i ON i.user_id = u.id WHERE u.name = '리더-TB'");
check(glB?.subject === "10002002" && glB?.employee_id === "10002002" && glB?.email === null, "GL without e-mail: login ID = 사번 (on the line-ownership record)");
const mt2 = await db.get("SELECT u.employee_id, u.email, i.subject FROM app_user u JOIN user_identity i ON i.user_id = u.id WHERE u.name = '보전2-T'");
check(mt2?.subject === "10003003" && mt2?.email === null, "사번 and e-mail present: login = 사번, the e-mail is not stored");
check(res2.problems.some((p) => p.includes("선임-T") && p.includes("no 사번")), "no 사번 and no e-mail → reported, no login");
const byEmp = await authenticate("10002002", res2.credentials.find((c) => c.loginId === "10002002")!.temporaryPassword, audit);
check(byEmp.role === "GAP_LEADER", "login with 사번 + temporary password works");

// 회원가입 closed (2026-10-08): no self-made accounts; administrator import + existing logins keep working.
const closed = async (fn: () => Promise<unknown>) => fn().then(() => false, (e: { code?: string }) => e.code === "REGISTRATION_CLOSED");
const before = Number((await db.get("SELECT COUNT(*) AS n FROM app_user"))!.n);
check(await closed(() => registerUser({ name: "가입-T", email: "join-t@andon.test", department: "UAP", password: "Passw0rd!x", passwordConfirm: "Passw0rd!x" })), "회원가입 rejected (REGISTRATION_CLOSED) by default");
check(await closed(() => identity.registerGoogleEmployee({ subject: "g-new-t", email: "g-new@andon.test", name: "구글-T" }, { employeeId: "G-T-1", name: "구글-T", department: "UAP", phone: "", kakaoId: "", companyEmail: "" } as never)), "Google onboarding of a NEW employee rejected too");
check(Number((await db.get("SELECT COUNT(*) AS n FROM app_user"))!.n) === before, "no account was created");
check((await authenticate("10002002", res2.credentials.find((c) => c.loginId === "10002002")!.temporaryPassword, audit)).active, "existing 사번 login still works");
process.env.ALLOW_SELF_REGISTRATION = "true";
check((await registerUser({ name: "가입-T", email: "join-t@andon.test", department: "UAP", password: "Passw0rd!x", passwordConfirm: "Passw0rd!x" })).role === "RESPONDER", "ALLOW_SELF_REGISTRATION=true reopens it (test servers)");
delete process.env.ALLOW_SELF_REGISTRATION;

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
