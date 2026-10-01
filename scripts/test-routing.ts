// Routing & responder-identity tests (npm run test:routing).
// Part A: pure unit tests of the routing resolver (no server, no database).
// Part B: API tests against a running server (BASE_URL, default http://localhost:3000).
//         Creates real "[TEST] routing" ANDONs and closes them again (see PROJECT.md: test data).
import { resolveDepartment, responderProblem, type RoutingRule } from "../src/lib/routing.ts";

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
let failures = 0;
function check(cond: unknown, label: string) {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.log(`  ✖ ${label}`);
  }
}

// ---------------------------------------------------------------- Part A: unit

function unitTests() {
  console.log("A) Routing resolver (unit)");
  const rules: RoutingRule[] = [
    { id: 10, categoryCode: "OTHER", lineCode: "L1", processId: 5, departmentCode: "LOGISTICS", active: true },
    { id: 11, categoryCode: "OTHER", lineCode: "L1", processId: null, departmentCode: "MAINTENANCE", active: true },
    { id: 12, categoryCode: "QUALITY", lineCode: "L1", processId: 7, departmentCode: "PRODUCTION", active: false },
  ];
  const ctx = (lineCode: string, processId: number, categoryCode: string, def: string) => ({
    lineCode,
    processId,
    categoryCode,
    categoryDefaultDepartment: def,
  });
  const r1 = resolveDepartment(rules, ctx("L1", 5, "OTHER", "PRODUCTION"));
  check(r1.departmentCode === "LOGISTICS" && r1.matchedBy === "LINE_PROCESS_CATEGORY" && r1.routingRuleId === 10, "line+process+category rule wins");
  const r2 = resolveDepartment(rules, ctx("L1", 6, "OTHER", "PRODUCTION"));
  check(r2.departmentCode === "MAINTENANCE" && r2.matchedBy === "LINE_CATEGORY", "line+category rule when no process rule");
  const r3 = resolveDepartment(rules, ctx("L2", 5, "OTHER", "PRODUCTION"));
  check(r3.departmentCode === "PRODUCTION" && r3.matchedBy === "CATEGORY_DEFAULT" && r3.routingRuleId === null, "other line → category default");
  const r4 = resolveDepartment(rules, ctx("L1", 5, "QUALITY", "QUALITY"));
  check(r4.departmentCode === "QUALITY" && r4.matchedBy === "CATEGORY_DEFAULT", "other category → category default");
  const r5 = resolveDepartment(rules, ctx("L1", 7, "QUALITY", "QUALITY"));
  check(r5.departmentCode === "QUALITY", "inactive rule is ignored");
  const reversed = resolveDepartment([...rules].reverse(), ctx("L1", 5, "OTHER", "PRODUCTION"));
  check(JSON.stringify(reversed) === JSON.stringify(r1), "result does not depend on rule order (deterministic)");

  const base = { id: 1, name: "x", departmentCode: "QUALITY", role: "RESPONDER", active: true, roleCanRespond: true };
  check(responderProblem(base, "QUALITY") === null, "eligible: active responder of the department");
  check(responderProblem({ ...base, active: false }, "QUALITY") === "INACTIVE", "inactive user rejected");
  check(responderProblem({ ...base, role: "OPERATOR", roleCanRespond: false }, "QUALITY") === "ROLE_NOT_ALLOWED", "operator role rejected");
  check(responderProblem(base, "MAINTENANCE") === "WRONG_DEPARTMENT", "other department rejected");
}

// ---------------------------------------------------------------- Part B: API

interface Meta {
  lines: { code: string }[];
  processes: { id: number; lineCode: string; name: string }[];
  categories: { code: string; defaultDepartment: string }[];
  users: { id: number; name: string; departmentCode: string; role: string }[];
}
interface Transition {
  action: string;
  fromStatus: string | null;
  toStatus: string;
  userName: string;
  userId: number | null;
  deviceId: string | null;
  clientIp: string | null;
  userAgent: string | null;
}
interface Detail {
  event: { id: string; status: string; departmentCode: string };
  transitions: Transition[];
  responsibility: { departmentCode: string; matchedBy: string; routingRuleId: number | null };
  eligibleResponders: { id: number; name: string; role: string }[];
}

const DEVICE = `dev-test-${Date.now().toString(36)}`;
const UA = "andon-routing-test/1.0";
const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ "x-andon-device": DEVICE, "user-agent": UA, ...extra });

async function apiTests() {
  console.log(`B) Routing & identity via API → ${BASE}`);
  const meta: Meta = await fetch(`${BASE}/api/meta`).then((r) => r.json());
  const proc = (line: string, name: string) => meta.processes.find((p) => p.lineCode === line && p.name === name)!;
  const user = (name: string) => meta.users.find((u) => u.name === name);
  const created: string[] = [];

  async function create(line: string, process: string, category: string, label: string, hdrs = headers()) {
    const f = new FormData();
    f.set("lineCode", line);
    f.set("processId", String(proc(line, process).id));
    f.set("categoryCode", category);
    f.set("description", `[TEST] routing: ${label}`);
    f.set("createdBy", "routing-test");
    f.set("clientRequestId", `rt-${Date.now()}-${Math.random()}`);
    const res = await fetch(`${BASE}/api/andons`, { method: "POST", body: f, headers: hdrs });
    const body = await res.json();
    if (body.event?.id) created.push(body.event.id);
    return body.event as { id: string; departmentCode: string };
  }
  const detail = (id: string): Promise<Detail> => fetch(`${BASE}/api/andons/${id}`).then((r) => r.json());
  const transition = async (id: string, body: Record<string, unknown>, hdrs = headers({ "Content-Type": "application/json" })) => {
    const res = await fetch(`${BASE}/api/andons/${id}/transition`, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  // -- routing by category
  console.log(" routing by category (T-GDI 1 / WCC Welding)");
  for (const c of meta.categories) {
    const ev = await create("TGDI1", "WCC Welding", c.code, `category ${c.code}`);
    const d = await detail(ev.id);
    check(
      ev.departmentCode === c.defaultDepartment && d.responsibility.matchedBy === "CATEGORY_DEFAULT",
      `${c.code} → ${c.defaultDepartment} (got ${ev.departmentCode}, ${d.responsibility.matchedBy})`,
    );
  }
  console.log(" routing rule override");
  const packing = await create("TGDI1", "Packing", "OTHER", "OTHER at Packing");
  const pd = await detail(packing.id);
  check(
    packing.departmentCode === "LOGISTICS" && pd.responsibility.matchedBy === "LINE_PROCESS_CATEGORY" && pd.responsibility.routingRuleId != null,
    `OTHER at T-GDI 1 / Packing → LOGISTICS by process rule (got ${packing.departmentCode}, ${pd.responsibility.matchedBy})`,
  );
  const leak = await create("TGDI1", "Leak Test", "OTHER", "OTHER at Leak Test");
  check(leak.departmentCode === "PRODUCTION", `OTHER at T-GDI 1 / Leak Test → PRODUCTION (category default; got ${leak.departmentCode})`);

  // -- eligibility list
  const q = await create("TGDI1", "WCC Final Inspection", "QUALITY", "identity checks");
  const qd = await detail(q.id);
  const names = qd.eligibleResponders.map((u) => u.name);
  check(
    names.includes("품질 담당 A") && names.includes("품질 담당 B") && names.includes("품질 GAP 리더") &&
      !names.includes("품질 담당 C (퇴직)") && !names.includes("보전 담당") && !names.includes("T-GDI 1 작업자"),
    `eligible responders for QUALITY event: ${names.join(", ")}`,
  );

  // -- identity validation (each rejection must leave the event and its history unchanged)
  console.log(" responder identity");
  const before = (await detail(q.id)).transitions.length;
  const unknownName = await transition(q.id, { action: "ACKNOWLEDGE", userName: "홍길동" });
  check(unknownName.status === 400 && unknownName.body.code === "UNKNOWN_RESPONDER", `unknown name → 400 UNKNOWN_RESPONDER (${unknownName.status} ${unknownName.body.code})`);
  const unknownId = await transition(q.id, { action: "ACKNOWLEDGE", userId: 999999 });
  check(unknownId.status === 400 && unknownId.body.code === "UNKNOWN_RESPONDER", `unknown id → 400 UNKNOWN_RESPONDER (${unknownId.status} ${unknownId.body.code})`);
  const inactive = await transition(q.id, { action: "ACKNOWLEDGE", userName: "품질 담당 C (퇴직)" });
  check(inactive.status === 403 && inactive.body.code === "INACTIVE_RESPONDER", `inactive user → 403 INACTIVE_RESPONDER (${inactive.status} ${inactive.body.code})`);
  const wrongDept = await transition(q.id, { action: "ACKNOWLEDGE", userId: user("보전 담당")!.id });
  check(wrongDept.status === 403 && wrongDept.body.code === "WRONG_DEPARTMENT", `maintenance user on QUALITY event → 403 WRONG_DEPARTMENT (${wrongDept.status} ${wrongDept.body.code})`);
  const mismatch = await transition(q.id, { action: "ACKNOWLEDGE", userId: user("품질 담당 A")!.id, userName: "품질 담당 B" });
  check(mismatch.status === 400 && mismatch.body.code === "RESPONDER_MISMATCH", `userId and userName disagree → 400 (${mismatch.status} ${mismatch.body.code})`);
  const noUser = await transition(q.id, { action: "ACKNOWLEDGE" });
  check(noUser.status === 400 && noUser.body.code === "USER_REQUIRED", `no responder → 400 USER_REQUIRED (${noUser.status} ${noUser.body.code})`);
  const after = await detail(q.id);
  check(after.event.status === "OPEN" && after.transitions.length === before, "rejected attempts changed nothing (still OPEN, no history rows)");

  const prod = await create("TGDI1", "WCC Welding", "PRODUCTION", "operator role check");
  const op = await transition(prod.id, { action: "ACKNOWLEDGE", userId: user("T-GDI 1 작업자")!.id });
  check(op.status === 403 && op.body.code === "ROLE_NOT_ALLOWED", `OPERATOR on own department's event → 403 ROLE_NOT_ALLOWED (${op.status} ${op.body.code})`);

  // -- valid responder + device audit
  console.log(" valid responder & device audit");
  const ack = await transition(q.id, { action: "ACKNOWLEDGE", userId: user("품질 담당 A")!.id });
  check(ack.status === 200 && ack.body.event.status === "ACKNOWLEDGED", `valid responder (by id) → ACKNOWLEDGED (${ack.status})`);
  const lastAck: Transition = ack.body.transitions.at(-1);
  check(lastAck.userId === user("품질 담당 A")!.id && lastAck.userName === "품질 담당 A", "history row has user id + canonical name");
  check(lastAck.deviceId === DEVICE, `history row has device id (${lastAck.deviceId})`);
  check(!!lastAck.clientIp, `history row has client IP (${lastAck.clientIp})`);
  check(lastAck.userAgent === UA, "history row has user agent");
  const gap = await transition(q.id, { action: "ACTION", userName: "품질 GAP 리더", comment: "[TEST] GAP leader action" }, {
    "Content-Type": "application/json",
    "x-andon-device": "bad id!",
  });
  check(gap.status === 200 && gap.body.event.status === "IN_PROGRESS", `GAP_LEADER of the department may act (by name) (${gap.status})`);
  check(gap.body.transitions.at(-1).deviceId === null, "invalid device id header is not stored");
  const create0: Transition = (await detail(q.id)).transitions[0];
  check(create0.action === "CREATE" && create0.deviceId === DEVICE && create0.userId === null, "CREATE row has device id (operator has no account → user id null)");

  // -- inbox filter is decided server-side
  const inbox = await fetch(`${BASE}/api/andons?scope=active&responderId=${user("품질 담당 B")!.id}`).then((r) => r.json());
  check(
    inbox.events.length > 0 && inbox.events.every((e: { departmentCode: string }) => e.departmentCode === "QUALITY"),
    `inbox for a QUALITY responder shows only QUALITY events (${inbox.events.length})`,
  );

  // -- close everything we created, with an eligible responder of each event
  for (const id of created) {
    const d = await detail(id);
    const who = d.eligibleResponders.find((u) => u.role === "RESPONDER") ?? d.eligibleResponders[0];
    if (d.event.status === "OPEN") await transition(id, { action: "ACKNOWLEDGE", userId: who.id });
    await transition(id, { action: "CLOSE", userId: who.id, comment: "[TEST] routing test cleanup" });
  }
  const final = await detail(q.id);
  console.log("     history: " + final.transitions.map((t) => `${t.action}:${t.userName}@${t.deviceId ?? "-"}`).join("  "));
  check(
    final.transitions.map((t) => `${t.fromStatus ?? "-"}>${t.toStatus}`).join(",") === "->OPEN,OPEN>ACKNOWLEDGED,ACKNOWLEDGED>IN_PROGRESS,IN_PROGRESS>CLOSED",
    "full history preserved in order (who / device / when per row)",
  );
  const stillActive = (await fetch(`${BASE}/api/andons?scope=active`).then((r) => r.json())).events.filter((e: { id: string }) => created.includes(e.id));
  check(stillActive.length === 0, `test events closed again (${created.length})`);
}

unitTests();
await apiTests();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
