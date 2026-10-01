// Master-data maintenance without SQL (npm run masterdata -- <command>). Administrator tool.
// Safe while the server is running. Every change is validated by the database (foreign keys,
// checks, triggers). Users are never deleted — deactivate them so history stays intact.
// <user> = numeric user id, local login e-mail, or emp:<employee ID> (e.g. emp:A1234).
//
//   list                                         departments, roles, users, routing rules, …
//   user add "<name>" <DEPARTMENT> <ROLE>        account without login (e.g. demo / operator)
//   user deactivate <user> | user activate <user>   (deactivated users cannot log in or respond)
//   user role <user> <ROLE>                      only administrators change roles (GAP_LEADER, …)
//   user dept <user> <DEPARTMENT>
//   user reset-password <user>                   prints a new temporary password once
//   user employee-id <user> <EMPLOYEE_ID>        assign the permanent employee ID (cannot be changed later);
//                                                pre-assigning prevents a newcomer from claiming that ID
//   user unlink-google <user>                    remove the Google login (e.g. lost Google account); ends sessions
//   user deactivate-test-accounts                deactivates all *@andon.test accounts (API tests)
//   route add <CATEGORY> <LINE> [<processId>] <DEPARTMENT> ["note"]
//   route deactivate <ruleId> | route activate <ruleId>
//   category default <CATEGORY> <DEPARTMENT>     department used when no routing rule matches
import crypto from "node:crypto";
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const { db, nowIso } = await import("../src/lib/server/db.ts");
const { hashPassword, normalizeEmail } = await import("../src/lib/server/auth.ts");

type Row = Record<string, unknown>;
const all = async (sql: string, ...p: (string | number)[]) => (await db.all(sql, ...p)) as Row[];

function table(title: string, rows: Row[]) {
  console.log(`\n## ${title}`);
  if (rows.length === 0) return console.log("  (none)");
  console.table(rows);
}

async function list() {
  table("plant", await all("SELECT code, name, name_ko, active FROM plant"));
  table("line", await all("SELECT code, name, plant_code, active FROM line ORDER BY sort_order"));
  table("process", await all("SELECT id, line_code, name, active FROM process ORDER BY line_code, sort_order"));
  table(
    "department (inactive rows = pre-v3 codes kept for history; successor = current department)",
    await all("SELECT code, display_code, name_ko, name_en, active, successor_code FROM department ORDER BY active DESC, sort_order"),
  );
  table("category (WHAT happened; default_department = routing when no rule matches)", await all("SELECT code, name_ko, default_department, active FROM category ORDER BY sort_order"));
  table("role", await all("SELECT code, name_ko, can_respond, escalation_level FROM role ORDER BY sort_order"));
  table(
    "app_user",
    await all(`SELECT u.id, u.employee_id, u.name, u.email, u.department_code AS dept, u.role, u.active, u.source,
                (SELECT group_concat(i.provider, '+') FROM user_identity i WHERE i.user_id = u.id) AS login
         FROM app_user u ORDER BY u.department_code, u.id`),
  );
  table(
    "routing_rule (most specific active rule wins: line+process+category > line+category > category default)",
    await all(`SELECT r.id, r.category_code, r.line_code, r.process_id, p.name AS process, r.department_code, r.active, r.note
         FROM routing_rule r LEFT JOIN process p ON p.id = r.process_id ORDER BY r.category_code, r.line_code`),
  );
  table("escalation_step (PREPARED, NOT ACTIVE)", await all("SELECT policy_code, step_no, target_role, after_minutes, active FROM escalation_step ORDER BY policy_code, step_no"));
}

async function userId(ref: string): Promise<number> {
  const row = /^\d+$/.test(ref)
    ? (await db.get("SELECT id FROM app_user WHERE id = ?", Number(ref)))
    : ref.toLowerCase().startsWith("emp:")
      ? (await db.get("SELECT id FROM app_user WHERE employee_id = ?", ref.slice(4).trim().toUpperCase()))
      : (await db.get("SELECT id FROM app_user WHERE email = ?", normalizeEmail(ref)));
  if (!row) throw new Error(`user not found: ${ref}`);
  return (row as { id: number }).id;
}

async function requireActiveDepartment(code: string) {
  if (!(await db.get("SELECT 1 FROM department WHERE code = ? AND active = 1", code))) {
    throw new Error(`department ${code} does not exist or is inactive (use ME, MT, UAP, QC, PCL)`);
  }
}

function changed(res: { changes: number | bigint }, what: string) {
  if (Number(res.changes) < 1) throw new Error(`${what}: not found`);
  console.log(`OK: ${what}`);
}

const [cmd, sub, ...args] = process.argv.slice(2);
try {
  if (!cmd || cmd === "list") await list();
  else if (cmd === "user" && sub === "add" && args.length === 3) {
    await requireActiveDepartment(args[1]);
    const r = (await db.run("INSERT INTO app_user (name, department_code, role, active, source, created_at) VALUES (?, ?, ?, 1, 'ADMIN', ?)", args[0], args[1], args[2], nowIso()));
    console.log(`OK: user #${r.lastInsertRowid} "${args[0]}" ${args[1]} ${args[2]} (no login; the person can register separately)`);
  } else if (cmd === "user" && (sub === "activate" || sub === "deactivate") && args.length === 1) {
    const id = await userId(args[0]);
    changed((await db.run("UPDATE app_user SET active = ? WHERE id = ?", sub === "activate" ? 1 : 0, id)), `user #${id} ${sub}d`);
  } else if (cmd === "user" && sub === "role" && args.length === 2) {
    const id = await userId(args[0]);
    changed((await db.run("UPDATE app_user SET role = ? WHERE id = ?", args[1], id)), `user #${id} role = ${args[1]}`);
  } else if (cmd === "user" && sub === "dept" && args.length === 2) {
    const id = await userId(args[0]);
    await requireActiveDepartment(args[1]);
    changed((await db.run("UPDATE app_user SET department_code = ? WHERE id = ?", args[1], id)), `user #${id} department = ${args[1]}`);
  } else if (cmd === "user" && sub === "reset-password" && args.length === 1) {
    const id = await userId(args[0]);
    const temp = `Andon-${crypto.randomBytes(6).toString("base64url")}1`;
    const hash = await hashPassword(temp);
    changed(
      (await db.run("UPDATE user_identity SET password_hash = ? WHERE user_id = ? AND provider = 'LOCAL'", hash, id)),
      `user #${id} password reset`,
    );
    // Existing sessions of this user are ended.
    (await db.run("UPDATE user_session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", nowIso(), id));
    console.log(`Temporary password (shown once): ${temp}`);
  } else if (cmd === "user" && sub === "employee-id" && args.length === 2) {
    const id = await userId(args[0]);
    const emp = args[1].trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(emp)) throw new Error("employee ID: 2-40 chars, letters / digits / - / _");
    changed((await db.run("UPDATE app_user SET employee_id = ? WHERE id = ?", emp, id)), `user #${id} employee ID = ${emp}`);
  } else if (cmd === "user" && sub === "unlink-google" && args.length === 1) {
    const id = await userId(args[0]);
    changed((await db.run("DELETE FROM user_identity WHERE user_id = ? AND provider = 'GOOGLE'", id)), `user #${id} Google login removed`);
    (await db.run("UPDATE user_session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", nowIso(), id));
  } else if (cmd === "user" && sub === "deactivate-test-accounts") {
    const r = (await db.run("UPDATE app_user SET active = 0 WHERE email LIKE '%@andon.test' AND active = 1"));
    console.log(`OK: ${r.changes} test account(s) deactivated`);
  } else if (cmd === "route" && sub === "add" && args.length >= 3 && args.length <= 5) {
    // route add <CATEGORY> <LINE> [<processId>] <DEPARTMENT> ["note"]
    const hasProcess = /^\d+$/.test(args[2]);
    const [category, line] = args;
    const processId = hasProcess ? Number(args[2]) : null;
    const dept = hasProcess ? args[3] : args[2];
    const note = (hasProcess ? args[4] : args[3]) ?? null;
    if (!dept) throw new Error('usage: route add <CATEGORY> <LINE> [<processId>] <DEPARTMENT> ["note"]');
    await requireActiveDepartment(dept);
    const r = (await db.run("INSERT INTO routing_rule (category_code, line_code, process_id, department_code, note, created_at) VALUES (?, ?, ?, ?, ?, ?)", category, line, processId, dept, note, nowIso()));
    console.log(`OK: routing rule #${r.lastInsertRowid}: ${category} @ ${line}${processId ? ` / process ${processId}` : ""} → ${dept}`);
  } else if (cmd === "route" && (sub === "activate" || sub === "deactivate") && args.length === 1) {
    changed((await db.run("UPDATE routing_rule SET active = ? WHERE id = ?", sub === "activate" ? 1 : 0, Number(args[0]))), `routing rule #${args[0]} ${sub}d`);
  } else if (cmd === "category" && sub === "default" && args.length === 2) {
    await requireActiveDepartment(args[1]);
    changed((await db.run("UPDATE category SET default_department = ? WHERE code = ?", args[1], args[0])), `category ${args[0]} default department = ${args[1]}`);
  } else {
    console.log("Unknown command. See the header of scripts/masterdata.ts or RUNBOOK.md §7.");
    process.exit(2);
  }
  if (cmd && cmd !== "list") {
    console.log("Changes apply immediately (also to logged-in users). Existing events keep the department they were routed to.");
  }
} catch (err) {
  console.error(`ERROR: ${(err as Error).message}`);
  process.exit(1);
}
