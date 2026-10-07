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

const { db, nowIso } = await import("../src/lib/server/db.ts");
const { applyOrgImport } = await import("../src/lib/server/lineAssignments.ts");
const { authenticate } = await import("../src/lib/server/auth.ts");
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
check(res.loginAdded === 3 && res.created === 5, `GL + SV + existing PC&L get a login; 2 MT, UAP 팀장, UAP 책임, PM created (added ${res.loginAdded}, created ${res.created})`);
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
check(res.problems.some((p) => p.includes("부서-T") && p.includes("unknown department")), "unknown department → reported");
const login = await authenticate("gl-a@andon.test", res.credentials.find((c) => c.email === "gl-a@andon.test")!.temporaryPassword, audit);
check(login.role === "GAP_LEADER", "the temporary password works for login");

const again = await acc.importAccounts(rows);
check(again.created === 0 && again.loginAdded === 0 && again.unchanged === 8, `repeat import changes nothing (unchanged ${again.unchanged})`);

const out = acc.writeCredentials(DIR, res.credentials);
const text = fs.readFileSync(out, "utf8");
check(text.split("\r\n").length === 9 && text.includes("임시 비밀번호"), "credentials file: header + 8 rows");
const stored = JSON.stringify(await db.all("SELECT * FROM app_user")) + JSON.stringify(await db.all("SELECT * FROM user_identity"));
check(!res.credentials.some((c) => stored.includes(c.temporaryPassword)), "temporary passwords are not stored in plain text");

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
