// Routing & responder-identity tests (npm run test:routing).
// Part A: pure unit tests of the routing resolver (no server, no database).
// Part B: API tests against a running server (BASE_URL, default http://localhost:3000), using
//         logged-in throw-away accounts (scripts/lib/testkit.ts). Creates "[TEST] routing" ANDONs and
//         closes them again; test accounts are deactivated at the end.
import { resolveDepartment, responderProblem, type RoutingRule } from "../src/lib/routing.ts";
import { BASE, Client, admin, check, createAndon, detail, finish, registerAccount, transition } from "./lib/testkit.ts";

// ---------------------------------------------------------------- Part A: unit

function unitTests() {
  console.log("A) Routing resolver (unit)");
  const rules: RoutingRule[] = [
    { id: 10, categoryCode: "OTHER", lineCode: "L1", processId: 5, departmentCode: "PCL", active: true },
    { id: 11, categoryCode: "OTHER", lineCode: "L1", processId: null, departmentCode: "MT", active: true },
    { id: 12, categoryCode: "QUALITY", lineCode: "L1", processId: 7, departmentCode: "UAP", active: false },
  ];
  const ctx = (lineCode: string, processId: number, categoryCode: string, def: string) => ({
    lineCode,
    processId,
    categoryCode,
    categoryDefaultDepartment: def,
  });
  const r1 = resolveDepartment(rules, ctx("L1", 5, "OTHER", "UAP"));
  check(r1.departmentCode === "PCL" && r1.matchedBy === "LINE_PROCESS_CATEGORY" && r1.routingRuleId === 10, "line+process+category rule wins");
  const r2 = resolveDepartment(rules, ctx("L1", 6, "OTHER", "UAP"));
  check(r2.departmentCode === "MT" && r2.matchedBy === "LINE_CATEGORY", "line+category rule when no process rule");
  const r3 = resolveDepartment(rules, ctx("L2", 5, "OTHER", "UAP"));
  check(r3.departmentCode === "UAP" && r3.matchedBy === "CATEGORY_DEFAULT" && r3.routingRuleId === null, "other line → category default");
  const r4 = resolveDepartment(rules, ctx("L1", 5, "QUALITY", "QC"));
  check(r4.departmentCode === "QC" && r4.matchedBy === "CATEGORY_DEFAULT", "other category → category default");
  const r5 = resolveDepartment(rules, ctx("L1", 7, "QUALITY", "QC"));
  check(r5.departmentCode === "QC", "inactive rule is ignored");
  const reversed = resolveDepartment([...rules].reverse(), ctx("L1", 5, "OTHER", "UAP"));
  check(JSON.stringify(reversed) === JSON.stringify(r1), "result does not depend on rule order (deterministic)");

  const base = { id: 1, name: "x", departmentCode: "QC", role: "RESPONDER", active: true, roleCanRespond: true };
  check(responderProblem(base, "QC") === null, "eligible: active responder of the department");
  check(responderProblem({ ...base, active: false }, "QC") === "INACTIVE", "inactive user rejected");
  check(responderProblem({ ...base, role: "OPERATOR", roleCanRespond: false }, "QC") === "ROLE_NOT_ALLOWED", "operator role rejected");
  check(responderProblem(base, "MT") === "WRONG_DEPARTMENT", "other department rejected");
}

// ---------------------------------------------------------------- Part B: API

interface Transition {
  action: string;
  fromStatus: string | null;
  toStatus: string;
  userName: string;
  userId: number | null;
  userDepartment: string | null;
  userRole: string | null;
  deviceId: string | null;
  clientIp: string | null;
  userAgent: string | null;
}

async function apiTests() {
  console.log(`B) Routing & identity via API → ${BASE}`);
  const meta = await fetch(`${BASE}/api/meta`).then((r) => r.json());
  const created: string[] = [];
  const create = async (line: string, process: string, category: string, label: string) => {
    const r = await createAndon(line, process, category, `[TEST] routing: ${label}`);
    if (r.body.event?.id) created.push(r.body.event.id);
    return r.body.event as { id: string; departmentCode: string };
  };

  // -- routing by category (category default departments come from the DB, not from this test)
  console.log(" routing by category (T-GDI 1 / WCC Welding)");
  for (const c of meta.categories as { code: string; defaultDepartment: string }[]) {
    const ev = await create("TGDI1", "WCC Welding", c.code, `category ${c.code}`);
    const d = (await detail(ev.id)).body;
    check(
      ev.departmentCode === c.defaultDepartment && d.responsibility.matchedBy === "CATEGORY_DEFAULT",
      `${c.code} → ${c.defaultDepartment} (got ${ev.departmentCode}, ${d.responsibility.matchedBy})`,
    );
  }
  console.log(" routing rule override");
  const packing = await create("TGDI1", "Packing", "OTHER", "OTHER at Packing");
  const pd = (await detail(packing.id)).body;
  check(
    packing.departmentCode === "PCL" && pd.responsibility.matchedBy === "LINE_PROCESS_CATEGORY" && pd.responsibility.routingRuleId != null,
    `OTHER at T-GDI 1 / Packing → PCL by process rule (got ${packing.departmentCode}, ${pd.responsibility.matchedBy})`,
  );
  check(pd.responsibility.departmentLabel === "PC&L · 물류", `PCL is displayed as "PC&L · 물류" (${pd.responsibility.departmentLabel})`);
  const leak = await create("TGDI1", "Leak Test", "OTHER", "OTHER at Leak Test");
  check(leak.departmentCode === "UAP", `OTHER at T-GDI 1 / Leak Test → UAP (category default; got ${leak.departmentCode})`);

  // -- eligibility list (seeded users)
  const q = await create("TGDI1", "WCC Final Inspection", "QUALITY", "identity checks");
  const names = ((await detail(q.id)).body.eligibleResponders as { name: string }[]).map((u) => u.name);
  check(
    names.includes("품질 담당 A") &&
      names.includes("품질 GAP 리더") &&
      !names.includes("품질 담당 C (퇴직)") &&
      !names.includes("보전 담당") &&
      !names.includes("T-GDI 1 작업자"),
    "eligible responders for a QC event exclude inactive / other department / operator",
  );

  // -- identity: always the session, never the body
  console.log(" responder identity (session only)");
  const qc = await registerAccount("QC", "routing-qc");
  const mt = await registerAccount("MT", "routing-mt");
  const before = ((await detail(q.id)).body.transitions as Transition[]).length;
  const anon = await transition(new Client("anon"), q.id, "ACKNOWLEDGE", undefined, { userName: "품질 담당 A" });
  check(anon.status === 401 && anon.body.code === "AUTH_REQUIRED", `no session, name in body → 401 AUTH_REQUIRED (${anon.status} ${anon.body.code})`);
  const spoofId = await transition(mt.client, q.id, "ACKNOWLEDGE", undefined, { userId: qc.id });
  check(spoofId.status === 400 && spoofId.body.code === "RESPONDER_MISMATCH", `MT session claiming the QC user id in the body → 400 (${spoofId.status} ${spoofId.body.code})`);
  const spoofName = await transition(mt.client, q.id, "ACKNOWLEDGE", undefined, { userName: "품질 담당 A" });
  check(spoofName.status === 400 && spoofName.body.code === "RESPONDER_MISMATCH", `MT session claiming a QC name in the body → 400 (${spoofName.status} ${spoofName.body.code})`);
  const wrongDept = await transition(mt.client, q.id, "ACKNOWLEDGE");
  check(wrongDept.status === 403 && wrongDept.body.code === "WRONG_DEPARTMENT", `MT responder on QC event → 403 WRONG_DEPARTMENT (${wrongDept.status} ${wrongDept.body.code})`);
  const after = (await detail(q.id)).body;
  check(after.event.status === "OPEN" && after.transitions.length === before, "rejected attempts changed nothing (still OPEN, no history rows)");

  // -- valid responder + audit
  console.log(" valid responder & audit");
  const ack = await transition(qc.client, q.id, "ACKNOWLEDGE");
  check(ack.status === 200 && ack.body.event.status === "ACKNOWLEDGED", `logged-in QC responder → ACKNOWLEDGED (${ack.status})`);
  const lastAck: Transition = ack.body.transitions.at(-1);
  check(lastAck.userId === qc.id && lastAck.userName === qc.name, "history row has user id + name of the session user");
  check(lastAck.userDepartment === "QC" && lastAck.userRole === "RESPONDER", `history row has department + role (${lastAck.userDepartment}, ${lastAck.userRole})`);
  check(lastAck.deviceId === qc.client.device, `history row has device id (${lastAck.deviceId})`);
  check(!!lastAck.clientIp && lastAck.userAgent === `andon-test/${qc.client.label}`, `history row has IP + user agent (${lastAck.clientIp})`);

  const gap = await registerAccount("QC", "routing-gap");
  check(admin("user", "role", gap.email, "GAP_LEADER").ok, "administrator sets role GAP_LEADER (CLI)");
  const act = await transition(gap.client, q.id, "ACTION", "[TEST] GAP leader action");
  check(act.status === 200 && act.body.event.status === "IN_PROGRESS" && act.body.transitions.at(-1).userRole === "GAP_LEADER", `GAP_LEADER of the department may act (${act.status})`);
  const badDevice = new Client("baddev");
  badDevice.cookie = gap.client.cookie;
  const bd = await badDevice.request(
    "POST",
    `/api/andons/${q.id}/transition`,
    { action: "ACTION", comment: "[TEST] bad device header" },
    { "x-andon-device": "bad id!" },
  );
  check(bd.status === 200 && bd.body.transitions.at(-1).deviceId === null, "invalid device id header is not stored");
  const create0: Transition = (await detail(q.id)).body.transitions[0];
  check(create0.action === "CREATE" && !!create0.deviceId && create0.userId !== null && create0.userRole === "GAP_LEADER", "CREATE row has device id and the calling GAP leader's account (GAP leader calls since 2026-10-06)");

  // -- server-side inbox filter (incl. events routed before the department change)
  const inbox = await qc.client.request("GET", "/api/andons?scope=active&mine=1");
  const depts = new Set((inbox.body.events as { departmentCode: string }[]).map((e) => e.departmentCode));
  check(
    inbox.status === 200 && inbox.body.events.length > 0 && [...depts].every((d) => d === "QC" || d === "QUALITY"),
    `inbox (mine=1) of a QC responder: only QC / pre-v3 QUALITY events (${[...depts].join(",")})`,
  );
  const inboxAnon = await new Client("anon2").request("GET", "/api/andons?scope=active&mine=1");
  check(inboxAnon.status === 401, "inbox mine=1 without session → 401");

  // -- pre-v3 department codes stay actionable through department.successor_code (read-only check)
  const legacy = (await fetch(`${BASE}/api/andons?scope=active`).then((r) => r.json())).events.find(
    (e: { departmentCode: string }) => e.departmentCode === "QUALITY",
  );
  if (legacy) {
    const asQc = (await qc.client.request("GET", `/api/andons/${legacy.id}`)).body;
    const asMt = (await mt.client.request("GET", `/api/andons/${legacy.id}`)).body;
    check(
      asQc.responsibility.effectiveDepartmentCode === "QC" && asQc.viewer.canRespond === true && asMt.viewer.canRespond === false,
      `pre-v3 event ${legacy.id} (QUALITY) is handled by QC (QC may respond, MT may not)`,
    );
  } else {
    console.log("  - (no open pre-v3 QUALITY event in this database: legacy check skipped)");
  }

  // -- close everything we created, with a registered responder of each event's department
  const closers = new Map<string, Client>([
    ["QC", qc.client],
    ["MT", mt.client],
  ]);
  for (const id of created) {
    const d = (await detail(id)).body;
    const dept = d.responsibility.effectiveDepartmentCode as string;
    if (!closers.has(dept)) closers.set(dept, (await registerAccount(dept, `routing-${dept}`)).client);
    const c = closers.get(dept)!;
    if (d.event.status === "OPEN") await transition(c, id, "ACKNOWLEDGE");
    await transition(c, id, "CLOSE", "[TEST] routing test cleanup");
  }
  const final = (await detail(q.id)).body.transitions as Transition[];
  console.log(
    "     history: " +
      final.map((t) => `${t.action}:${t.userName}(${t.userDepartment ?? "-"}/${t.userRole ?? "-"})@${t.deviceId ?? "-"}`).join("  "),
  );
  check(
    final.map((t) => `${t.fromStatus ?? "-"}>${t.toStatus}`).join(",") ===
      "->OPEN,OPEN>ACKNOWLEDGED,ACKNOWLEDGED>IN_PROGRESS,IN_PROGRESS>IN_PROGRESS,IN_PROGRESS>CLOSED",
    "full history preserved in order (who / department / role / device / when per row)",
  );
  const stillActive = (await fetch(`${BASE}/api/andons?scope=active`).then((r) => r.json())).events.filter((e: { id: string }) =>
    created.includes(e.id),
  );
  check(stillActive.length === 0, `test events closed again (${created.length})`);
}

unitTests();
await apiTests();
finish();
