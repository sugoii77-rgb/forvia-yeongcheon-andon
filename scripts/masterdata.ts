// Master-data maintenance without SQL (npm run masterdata -- <command>).
// Safe while the server is running. Every change is validated by the database (foreign keys,
// checks, triggers). Users are never deleted — deactivate them so history stays intact.
//
//   list                                         plants, lines, processes, categories, departments, roles, users, routing
//   user add "<name>" <DEPARTMENT> <ROLE>        e.g. user add "품질 담당 D" QUALITY RESPONDER
//   user deactivate <id> | user activate <id>
//   user role <id> <ROLE> | user dept <id> <DEPARTMENT>
//   route add <CATEGORY> <LINE> [<processId>] <DEPARTMENT> ["note"]
//   route deactivate <ruleId> | route activate <ruleId>
//   category default <CATEGORY> <DEPARTMENT>     department used when no routing rule matches
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const { getDb, nowIso } = await import("../src/lib/server/db.ts");
const db = getDb();

type Row = Record<string, unknown>;
const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[];

function table(title: string, rows: Row[]) {
  console.log(`\n## ${title}`);
  if (rows.length === 0) return console.log("  (none)");
  console.table(rows);
}

function list() {
  table("plant", all("SELECT code, name, name_ko, active FROM plant"));
  table("line", all("SELECT code, name, plant_code, active FROM line ORDER BY sort_order"));
  table("process", all("SELECT id, line_code, name, active FROM process ORDER BY line_code, sort_order"));
  table("department", all("SELECT code, name_ko, name_en, active FROM department"));
  table("category (default_department = routing when no rule matches)", all("SELECT code, name_ko, default_department, active FROM category ORDER BY sort_order"));
  table("role", all("SELECT code, name_ko, can_respond, escalation_level FROM role ORDER BY sort_order"));
  table("app_user", all("SELECT id, name, department_code, role, active FROM app_user ORDER BY department_code, id"));
  table(
    "routing_rule (most specific active rule wins: line+process+category > line+category > category default)",
    all(`SELECT r.id, r.category_code, r.line_code, r.process_id, p.name AS process, r.department_code, r.active, r.note
         FROM routing_rule r LEFT JOIN process p ON p.id = r.process_id ORDER BY r.category_code, r.line_code`),
  );
  table("escalation_step (PREPARED, NOT ACTIVE)", all("SELECT policy_code, step_no, target_role, after_minutes, active FROM escalation_step ORDER BY policy_code, step_no"));
}

function changed(res: { changes: number | bigint }, what: string) {
  if (Number(res.changes) !== 1) throw new Error(`${what}: not found`);
  console.log(`OK: ${what}`);
}

const [cmd, sub, ...args] = process.argv.slice(2);
try {
  if (!cmd || cmd === "list") list();
  else if (cmd === "user" && sub === "add" && args.length === 3) {
    const r = db.prepare("INSERT INTO app_user (name, department_code, role, active) VALUES (?, ?, ?, 1)").run(args[0], args[1], args[2]);
    console.log(`OK: user #${r.lastInsertRowid} "${args[0]}" ${args[1]} ${args[2]}`);
  } else if (cmd === "user" && (sub === "activate" || sub === "deactivate") && args.length === 1) {
    changed(db.prepare("UPDATE app_user SET active = ? WHERE id = ?").run(sub === "activate" ? 1 : 0, Number(args[0])), `user #${args[0]} ${sub}d`);
  } else if (cmd === "user" && sub === "role" && args.length === 2) {
    changed(db.prepare("UPDATE app_user SET role = ? WHERE id = ?").run(args[1], Number(args[0])), `user #${args[0]} role = ${args[1]}`);
  } else if (cmd === "user" && sub === "dept" && args.length === 2) {
    changed(db.prepare("UPDATE app_user SET department_code = ? WHERE id = ?").run(args[1], Number(args[0])), `user #${args[0]} department = ${args[1]}`);
  } else if (cmd === "route" && sub === "add" && (args.length >= 3 && args.length <= 5)) {
    // route add <CATEGORY> <LINE> [<processId>] <DEPARTMENT> ["note"]
    const hasProcess = /^\d+$/.test(args[2]);
    const [category, line] = args;
    const processId = hasProcess ? Number(args[2]) : null;
    const dept = hasProcess ? args[3] : args[2];
    const note = (hasProcess ? args[4] : args[3]) ?? null;
    if (!dept) throw new Error("usage: route add <CATEGORY> <LINE> [<processId>] <DEPARTMENT> [\"note\"]");
    const r = db
      .prepare("INSERT INTO routing_rule (category_code, line_code, process_id, department_code, note, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(category, line, processId, dept, note, nowIso());
    console.log(`OK: routing rule #${r.lastInsertRowid}: ${category} @ ${line}${processId ? ` / process ${processId}` : ""} → ${dept}`);
  } else if (cmd === "route" && (sub === "activate" || sub === "deactivate") && args.length === 1) {
    changed(db.prepare("UPDATE routing_rule SET active = ? WHERE id = ?").run(sub === "activate" ? 1 : 0, Number(args[0])), `routing rule #${args[0]} ${sub}d`);
  } else if (cmd === "category" && sub === "default" && args.length === 2) {
    changed(db.prepare("UPDATE category SET default_department = ? WHERE code = ?").run(args[1], args[0]), `category ${args[0]} default department = ${args[1]}`);
  } else {
    console.log("Unknown command. See the header of scripts/masterdata.ts or RUNBOOK.md §7.");
    process.exit(2);
  }
  if (cmd && cmd !== "list") {
    console.log("Changes apply to NEW ANDONs immediately; existing events keep the department they were routed to.");
  }
} catch (err) {
  console.error(`ERROR: ${(err as Error).message}`);
  process.exit(1);
}
