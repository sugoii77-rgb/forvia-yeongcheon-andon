// Bulk login accounts from the plant's list (GAP leaders, SV, MT, PC&L, …): one row per person with name,
// department, position, employee number (사번) and company e-mail. Login ID (plant decision 2026-10-08):
// the 사번 when there is one (GAP leaders have no company e-mail), otherwise the e-mail. Only the login ID
// is stored (app_user.employee_id / user_identity.subject; the e-mail only when it is the login). Phone,
// KakaoTalk ID and Google ID columns are never read.
//
// Matching — never a duplicate person:
//  - UAP SV / GL: the employee created by the line-ownership import (import_key) gets the login, so the
//    call screen shows "my lines" right away. Not found → reported, nothing created.
//  - other departments: an active account with the same name in that department gets the login (when it
//    has none); none → a new account. Two with the same name → reported, skipped.
// Temporary passwords go to a file for the administrator (never printed). All in one transaction.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { hashPassword, normalizeEmail } from "../../src/lib/server/auth.ts";
import { db, nowIso } from "../../src/lib/server/db.ts";
import { importKey } from "../../src/lib/server/lineAssignments.ts";

export interface AccountRow {
  line: number;
  name: string;
  department: string; // raw text from the sheet
  position: string; // raw text (SV, GL, 팀장, 책임, …)
  email: string;
  /** 사번 — the login ID when present */
  employeeId: string;
  /** department text that is not a department name (taken from the block above) — reported */
  deptNote?: string;
  /** optional column "기본알림" (Y / O / 1): always messaged on QC / MT calls (UAP 팀장, UAP 책임) */
  callDefault?: boolean;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Department text → department code. */
export function departmentOf(text: string): string | null {
  const t = norm(text).toUpperCase().replace(/\s/g, "");
  if (!t) return null;
  if (/^(UAP|생산|AP-?\d|AQ-?\d|BENDING|RESO)/.test(t)) return "UAP";
  if (/^(MT|보전|MAINT)/.test(t)) return "MT";
  if (/^(PC&L|PCL|PC&L|물류|LOGIS)/.test(t)) return "PCL";
  if (/^(SQA|외주품질)/.test(t)) return "QC"; // SQA is part of QC (2026-10-08)
  if (/^(QC|품질|QUAL)/.test(t)) return "QC";
  if (/^(ME|생산기술)/.test(t)) return "ME";
  return null;
}

/** Position text → role. SV → SUPERVISOR, GL → GAP_LEADER, PM / 공장장 → PLANT_MANAGER, everybody else (팀장, 책임, …) → RESPONDER. */
export function roleOf(position: string): "SUPERVISOR" | "GAP_LEADER" | "PLANT_MANAGER" | "RESPONDER" {
  const t = norm(position).toUpperCase().replace(/[\s/.]/g, "");
  if (t === "PM" || t.includes("PLANTMANAGER") || t.includes("공장장")) return "PLANT_MANAGER";
  if (t === "SV" || t.includes("SUPERVISOR") || t.includes("감독")) return "SUPERVISOR";
  if (t === "GL" || t.includes("GAP") || t.includes("그룹장")) return "GAP_LEADER";
  return "RESPONDER";
}

function cellText(cell: ExcelJS.Cell): string {
  const v = (cell.isMerged ? cell.master : cell).value as unknown;
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: string; hyperlink?: string };
    if (o.richText) return norm(o.richText.map((x) => x.text).join(""));
    if (o.text !== undefined) return norm(String(o.text));
    return norm(String(o.result ?? ""));
  }
  return norm(String(v));
}

const HEAD = {
  name: /^(이름|성명|name)$/i,
  department: /^(부서|department|dept)$/i,
  department1: /^부서-?1$/i,
  position: /^(직급|직책|역할|position|role)$/i,
  email: /(로그인|login|계정|e-?mail|이메일|메일)/i,
  employeeId: /^(사번|employee\s*(id|no))$/i,
  callDefault: /(기본\s*알림|default)/i,
};

/**
 * Reads the account rows of an .xlsx (first sheet with the header row) or .csv. Columns are found by
 * their title; only name / department / position / login e-mail are read.
 */
export async function readAccountFile(file: string): Promise<AccountRow[]> {
  let table: string[][];
  if (file.toLowerCase().endsWith(".csv")) {
    table = fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).map((l) => l.split(",").map(norm));
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    table = [];
    for (const ws of wb.worksheets) {
      const rows: string[][] = [];
      for (let r = 1; r <= ws.rowCount; r++) {
        const row: string[] = [];
        for (let c = 1; c <= ws.columnCount; c++) row.push(cellText(ws.getCell(r, c)));
        rows.push(row);
      }
      if (rows.some((row) => row.some((x) => HEAD.name.test(x)) && row.some((x) => HEAD.email.test(x)))) {
        table = rows;
        break;
      }
    }
  }
  const h = table.findIndex((row) => row.some((x) => HEAD.name.test(x)) && row.some((x) => HEAD.email.test(x)));
  if (h < 0) throw new Error("header row with 이름 and 로그인/E-mail columns not found");
  const col = (re: RegExp) => table[h].findIndex((x) => re.test(x));
  const c = { name: col(HEAD.name), department: col(HEAD.department), department1: col(HEAD.department1), position: col(HEAD.position), email: col(HEAD.email), employeeId: col(HEAD.employeeId), callDefault: col(HEAD.callDefault) };
  if (c.department < 0 && c.department1 < 0) throw new Error("column 부서 not found");
  const out: AccountRow[] = [];
  let lastDept = "";
  for (let r = h + 1; r < table.length; r++) {
    const row = table[r];
    const name = (row[c.name] ?? "").replace(/\((A|B)\)$/, "").trim();
    // 부서-1 (UAP area AP-1 …, Mt, PC&L) first, then 부서; blank = the department of the rows above
    // Only text that names a department counts: QC rows carry their sub-role there ("AQ CS", "AP 공정 QC")
    // and continue the QC block above.
    const own = [c.department1 >= 0 ? row[c.department1] : "", c.department >= 0 ? row[c.department] : ""].find((x) => x && departmentOf(x)) ?? "";
    const dept = own || lastDept;
    if (own) lastDept = own;
    const rawDept = [c.department1 >= 0 ? row[c.department1] : "", c.department >= 0 ? row[c.department] : ""].find((x) => x && x !== "-") ?? "";
    const deptNote = !own && rawDept && lastDept ? rawDept : undefined;
    const email = /@/.test(row[c.email] ?? "") ? row[c.email] : "";
    const employeeId = c.employeeId >= 0 ? (row[c.employeeId] ?? "").replace(/\s/g, "").toUpperCase() : "";
    if (!name || name === "-") continue;
    out.push({ line: r + 1, name, department: dept, deptNote, position: c.position >= 0 ? (row[c.position] ?? "") : "", email, employeeId, callDefault: c.callDefault >= 0 && /^(Y|YES|O|1|V|✔|예)$/i.test(row[c.callDefault] ?? "") });
  }
  return out;
}

export interface ImportResult {
  created: number;
  loginAdded: number;
  unchanged: number;
  problems: string[];
  /** For the administrator only — written to a file, never printed. */
  credentials: { name: string; department: string; loginId: string; temporaryPassword: string }[];
}

/** Applies the rows in ONE transaction (all or nothing for the database). */
export async function importAccounts(rows: AccountRow[]): Promise<ImportResult> {
  const res: ImportResult = { created: 0, loginAdded: 0, unchanged: 0, problems: [], credentials: [] };
  const prepared: (AccountRow & { dept: string; role: ReturnType<typeof roleOf>; mail: string; login: string; temp: string; hash: string })[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    // the plant manager may be listed without a department: he belongs to production (UAP)
    const dept = departmentOf(r.department) ?? (roleOf(r.position) === "PLANT_MANAGER" ? "UAP" : null);
    const mail = r.email ? normalizeEmail(r.email) : "";
    if (!dept) {
      res.problems.push(`row ${r.line} (${r.name}): unknown department "${r.department}"`);
      continue;
    }
    if (r.employeeId && !/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(r.employeeId)) {
      res.problems.push(`row ${r.line} (${r.name}): 사번 is not valid`);
      continue;
    }
    if (!r.employeeId && !EMAIL.test(mail)) {
      res.problems.push(`row ${r.line} (${r.name}): no 사번 and no valid e-mail — no login created`);
      continue;
    }
    if (r.deptNote) res.problems.push(`row ${r.line} (${r.name}): "${r.deptNote}" is not a department name — took ${dept} from the rows above (check)`);
    const login = r.employeeId || mail;
    if (seen.has(login)) {
      res.problems.push(`row ${r.line} (${r.name}): the same login ID appears twice in the file`);
      continue;
    }
    seen.add(login);
    const temp = `Andon-${crypto.randomBytes(6).toString("base64url")}1`;
    prepared.push({ ...r, dept, role: roleOf(r.position), mail, login, temp, hash: await hashPassword(temp) }); // hashing outside the transaction
  }
  // 팀장 → team_leader (2-hour escalation); 기본알림 column or UAP 팀장 → call_default (plant meeting 2026-10-07)
  const flags = async (id: number, p: (typeof prepared)[number]) => {
    const leader = /팀장/.test(p.position);
    await db.run(
      "UPDATE app_user SET team_leader = MAX(team_leader, ?), call_default = MAX(call_default, ?) WHERE id = ?",
      leader ? 1 : 0,
      p.callDefault || (leader && p.dept === "UAP") ? 1 : 0,
      id,
    );
  };
  await db.transaction(async () => {
    for (const p of prepared) {
      let userId: number | null = null;
      if (p.dept === "UAP" && (p.role === "SUPERVISOR" || p.role === "GAP_LEADER")) {
        const u = await db.get("SELECT id, role, active FROM app_user WHERE import_key = ?", importKey(p.name));
        if (!u) {
          res.problems.push(`row ${p.line} (${p.name}): not in the line-ownership list (SV / GL) — not created; check the name`);
          continue;
        }
        if (u.role !== p.role) res.problems.push(`row ${p.line} (${p.name}): list says ${p.role}, line ownership says ${u.role as string} — role not changed`);
        userId = Number(u.id);
      } else {
        const same = await db.all("SELECT id FROM app_user WHERE name = ? AND department_code = ? AND active = 1", p.name, p.dept);
        if (same.length > 1) {
          res.problems.push(`row ${p.line} (${p.name}): ${same.length} active accounts with this name in ${p.dept} — skipped`);
          continue;
        }
        userId = same.length ? Number(same[0].id) : null;
      }
      // the e-mail is stored only when it is the login ID (no 사번)
      const storedMail = p.employeeId ? null : p.mail;
      const empOwner = p.employeeId ? await db.get("SELECT id FROM app_user WHERE employee_id = ?", p.employeeId) : undefined;
      const mailOwner = storedMail ? await db.get("SELECT id FROM app_user WHERE email = ?", storedMail) : undefined;
      const ident = await db.get("SELECT user_id FROM user_identity WHERE provider = 'LOCAL' AND subject = ?", p.login);
      if (userId !== null) {
        const has = await db.get("SELECT subject FROM user_identity WHERE user_id = ? AND provider = 'LOCAL'", userId);
        if (has) {
          if (has.subject !== p.login) res.problems.push(`row ${p.line} (${p.name}): already has a different login — not changed`);
          await flags(userId, p);
          res.unchanged++;
          continue;
        }
        const cur = await db.get("SELECT employee_id FROM app_user WHERE id = ?", userId);
        if (p.employeeId && cur?.employee_id && cur.employee_id !== p.employeeId) {
          res.problems.push(`row ${p.line} (${p.name}): a different 사번 is already recorded — skipped`);
          continue;
        }
      }
      if ((empOwner && Number(empOwner.id) !== userId) || (mailOwner && Number(mailOwner.id) !== userId) || ident) {
        res.problems.push(`row ${p.line} (${p.name}): login ID already used by another account — skipped`);
        continue;
      }
      if (userId === null) {
        const r = await db.run(
          "INSERT INTO app_user (name, email, employee_id, department_code, role, active, source, created_at) VALUES (?, ?, ?, ?, ?, 1, 'ADMIN', ?)",
          p.name, storedMail, p.employeeId || null, p.dept, p.role, nowIso(),
        );
        userId = Number(r.lastInsertRowid);
        res.created++;
      } else {
        if (storedMail) await db.run("UPDATE app_user SET email = ? WHERE id = ?", storedMail, userId);
        if (p.employeeId) await db.run("UPDATE app_user SET employee_id = ? WHERE id = ? AND employee_id IS NULL", p.employeeId, userId);
        res.loginAdded++;
      }
      await db.run("INSERT INTO user_identity (user_id, provider, subject, password_hash, created_at) VALUES (?, 'LOCAL', ?, ?, ?)", userId, p.login, p.hash, nowIso());
      await flags(userId, p);
      res.credentials.push({ name: p.name, department: p.dept, loginId: p.login, temporaryPassword: p.temp });
    }
  });
  return res;
}

/** Writes the temporary passwords for the administrator (CSV, UTF-8 with BOM for Excel). */
export function writeCredentials(dir: string, creds: ImportResult["credentials"]): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `temp-passwords-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  fs.writeFileSync(file, "﻿" + ["이름,부서,로그인 아이디 (사번 또는 이메일),임시 비밀번호", ...creds.map((c) => [c.name, c.department, c.loginId, c.temporaryPassword].map(q).join(","))].join("\r\n"));
  return file;
}
