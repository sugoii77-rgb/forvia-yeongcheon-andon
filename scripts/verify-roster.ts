// npm run verify:roster -- <workbook.xlsx> <MT|PCL|QC>
// Read-only: compares a department's people in the plant workbook (sheet 개인정보, block "부서-1" = Mt /
// PC&L / QC) with the accounts registered in the configured database (SQLite file, or Turso via
// `vercel env run`). People register THEMSELVES (registration / Google) and link KakaoTalk on /me —
// the workbook is only a checklist; nothing is imported. Matching is by exact name (names only).
// Reads ONLY 부서-1, 이름, 직급 — never 사번, Google ID, KakaoTalk ID, 연락처 or e-mail.
//
// Team leaders (직급 팀장) are NOT initial ANDON recipients (plant decision 2026-10-06: escalation later,
// with Reaction Rules). Self-registration makes everyone RESPONDER, so a registered team leader is
// reported until an administrator changes the role (npm run masterdata -- user role <user> ENGINEER).
import fs from "node:fs";
import ExcelJS from "exceljs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const [file, deptArg] = process.argv.slice(2);
const BLOCK: Record<string, string> = { MT: "Mt", PCL: "PC&L", QC: "QC" };
if (!file || !fs.existsSync(file) || !deptArg || !BLOCK[deptArg.toUpperCase()]) {
  console.error("usage: npm run verify:roster -- <workbook.xlsx> <MT|PCL|QC>");
  process.exit(2);
}
const dept = deptArg.toUpperCase();

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
function text(cell: ExcelJS.Cell): string {
  const v = (cell.isMerged ? cell.master : cell).value as unknown;
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: string };
    if (o.richText) return norm(o.richText.map((t) => t.text).join(""));
    return norm(String(o.result ?? o.text ?? ""));
  }
  return norm(String(v));
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const ws = wb.getWorksheet("개인정보");
if (!ws) throw new Error('sheet "개인정보" not found');
// header row: find the columns by title (부서-1, 이름, 직급)
let hdr = 0;
const col: Record<string, number> = {};
for (let r = 1; r <= Math.min(ws.rowCount, 10) && !hdr; r++) {
  for (let c = 1; c <= ws.columnCount; c++) {
    const t = text(ws.getCell(r, c));
    if (t === "부서-1" || t === "이름" || t === "직급") col[t] = c;
  }
  if (col["부서-1"] && col["이름"] && col["직급"]) hdr = r;
}
if (!hdr) throw new Error("columns 부서-1 / 이름 / 직급 not found");

// block = a row with 부서-1 set, continued by following rows with a name and an empty 부서-1
const people: { name: string; rank: string }[] = [];
let inBlock = false;
for (let r = hdr + 1; r <= ws.rowCount; r++) {
  const area = text(ws.getCell(r, col["부서-1"]));
  const name = text(ws.getCell(r, col["이름"])).replace(/\((A|B)\)$/, "");
  if (area) inBlock = area.toLowerCase() === BLOCK[dept].toLowerCase();
  else if (!name) inBlock = false;
  if (inBlock && name) people.push({ name, rank: text(ws.getCell(r, col["직급"])) });
}
if (people.length === 0) throw new Error(`no people found in block "${BLOCK[dept]}"`);

const { db } = await import("../src/lib/server/db.ts");
const info = await db.info();
const users = (await db.all("SELECT id, name, role, active, source FROM app_user WHERE department_code = ?", dept)) as {
  id: number; name: string; role: string; active: number; source: string;
}[];
const kakao = new Set(
  ((await db.all("SELECT user_id FROM user_notification_channel WHERE provider = 'KAKAO' AND verified = 1 AND active = 1")) as { user_id: number }[]).map((r) => r.user_id),
);

console.log(`database : ${info.label} (${info.kind}) — read only`);
console.log(`roster   : ${dept} — ${people.length} people in the workbook (names only)\n`);
let ready = 0;
const issues: string[] = [];
for (const p of people) {
  const leader = p.rank === "팀장";
  const acc = users.filter((u) => u.name === p.name && u.active === 1);
  let status: string;
  if (acc.length === 0) status = "not registered yet";
  else if (acc.length > 1) {
    status = `${acc.length} active accounts (#${acc.map((a) => a.id).join(", #")}) — deactivate the extra one`;
    issues.push(`${p.name}: duplicate accounts`);
  } else {
    const a = acc[0];
    const parts = [`account #${a.id} ${a.role}`, kakao.has(a.id) ? "Kakao ✔" : "Kakao not linked"];
    if (leader && a.role === "RESPONDER") {
      parts.push("team leader is RESPONDER → would get every ANDON; change role (escalation later)");
      issues.push(`${p.name}: team leader registered as RESPONDER`);
    } else if (!leader && a.role === "RESPONDER" && kakao.has(a.id)) ready++;
    status = parts.join(" · ");
  }
  console.log(`  ${leader ? "[팀장]" : "      "} ${p.name.padEnd(6)} ${status}`);
}
const names = new Set(people.map((p) => p.name));
const others = users.filter((u) => u.active === 1 && !names.has(u.name));
console.log(`\nother active ${dept} accounts not in the roster: ${others.length}${others.length ? " → " + others.map((u) => `#${u.id} ${u.name} (${u.role}, ${u.source})`).join(", ") : ""}`);
const responders = people.filter((p) => p.rank !== "팀장").length;
console.log(`ready to receive ${dept} ANDON alerts (registered RESPONDER + Kakao linked): ${ready} / ${responders}`);
if (issues.length) console.log(`to fix: ${issues.length}\n  - ${issues.join("\n  - ")}`);
process.exit(0);
