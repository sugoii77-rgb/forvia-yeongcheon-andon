// GAP-leader ANDON call (npm run test:call) — plant decision 2026-10-06: the GAP leader judges the
// situation and calls one or more departments and, within each, the people who get the message.
// Runs against a test server (BASE_URL) whose DATABASE_PATH is given too (append-only check, admin CLI).
//   BASE_URL=http://localhost:3101 DATABASE_PATH=work/<copy>.db npm run test:call
import path from "node:path";
import { BASE, Client, admin, callerClient, check, createAndon, detail, finish, registerAccount, transition } from "./lib/testkit.ts";

if (!process.env.DATABASE_PATH || !path.resolve(process.env.DATABASE_PATH).startsWith(path.resolve("work") + path.sep)) {
  throw new Error("test:call requires an isolated DATABASE_PATH under C:\\andon\\work (same as the test server)");
}
delete process.env.TURSO_DATABASE_URL;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`GAP-leader call tests → ${BASE}`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check(path.resolve(health.db) === path.resolve(process.env.DATABASE_PATH!), "test server uses the isolated test DB");

  const qc1 = await registerAccount("QC", "call-qc");
  const qc2 = await registerAccount("QC", "call-qc");
  const mt = await registerAccount("MT", "call-mt");
  const pcl = await registerAccount("PCL", "call-pcl");
  const gap = await callerClient();

  console.log("CALL TARGETS");
  check((await new Client("anon").request("GET", "/api/call-targets")).status === 401, "call targets without login → 401");
  check((await qc1.client.request("GET", "/api/call-targets")).status === 403, "call targets for a RESPONDER → 403 (callers only)");
  const t = await gap.request("GET", "/api/call-targets");
  const deps = (t.body.departments ?? []) as { code: string; members: Record<string, unknown>[] }[];
  check(t.status === 200 && deps.some((d) => d.code === "QC") && deps.some((d) => d.code === "MT") && deps.some((d) => d.code === "PCL"), "GAP leader gets QC / MT / PC&L with their people");
  check(!deps.some((d) => d.code === "UAP"), "production (UAP) is not a callable department");
  check(deps.flatMap((d) => d.members).every((m) => Object.keys(m).sort().join() === "id,name,roleName"), "people list holds id, name, role only (no contact data)");
  check(deps.find((d) => d.code === "QC")!.members.some((m) => m.id === qc1.id), "a newly registered QC member is listed");

  console.log("CALL");
  const anon = await createAndon("TGDI1", "WCC Final Inspection", "QUALITY", "[TEST] call: anonymous", new Client("anon"));
  check(anon.status === 401 && anon.body.code === "AUTH_REQUIRED", `call without login → 401 (${anon.body.code})`);
  const resp = await createAndon("TGDI1", "WCC Final Inspection", "QUALITY", "[TEST] call: responder", qc1.client);
  check(resp.status === 403 && resp.body.code === "ROLE_NOT_ALLOWED", `call by a RESPONDER → 403 (${resp.body.code})`);
  const bad = async (call: { departments: string[]; recipients?: number[] }, code: string, label: string) => {
    const r = await createAndon("TGDI1", "WCC Final Inspection", "QUALITY", `[TEST] call: ${label}`, gap, undefined, call);
    check(r.status === 400 && r.body.code === code, `${label} → 400 ${code} (${r.body.code})`);
  };
  await bad({ departments: ["UAP"] }, "INVALID_DEPARTMENT", "production as department");
  await bad({ departments: ["NOPE"] }, "INVALID_DEPARTMENT", "unknown department");
  await bad({ departments: ["QC"], recipients: [mt.id] }, "INVALID_RECIPIENT", "recipient outside the chosen departments");

  const ok = await createAndon("TGDI1", "WCC Final Inspection", "QUALITY", "[TEST] call: QC + MT", gap, undefined, { departments: ["QC", "MT"], recipients: [qc1.id, mt.id] });
  const ev = ok.body.event;
  check(ok.status === 201 && ev.departmentCode === "QC" && ev.departments.map((d: { code: string }) => d.code).join() === "QC,MT", `GAP leader calls QC + MT → 201, both departments, first = primary (${ok.status})`);
  check(/QC · 품질, MT · 보전/.test(ev.departmentLabel), `label lists both departments (${ev.departmentLabel})`);

  const d = (await detail(ev.id)).body;
  const create = d.transitions[0];
  check(create.action === "CREATE" && create.userRole === "GAP_LEADER" && create.userId != null, "history: CREATE recorded with the GAP leader's account and role");
  check(d.responsibility.matchedBy === "GAP_LEADER_CALL", "responsibility shown as 'GAP 리더 호출'");
  check(d.eligibleResponders.some((u: { id: number }) => u.id === mt.id) && d.eligibleResponders.some((u: { id: number }) => u.id === qc2.id) && !d.eligibleResponders.some((u: { id: number }) => u.id === pcl.id), "eligible: members of BOTH departments (also those not messaged), not PC&L");

  // notifications run after the response (mock provider): exactly the chosen people
  let notes: { recipient: string; status: string }[] = [];
  for (let i = 0; i < 20 && notes.length < 2; i++) {
    await sleep(250);
    notes = (await detail(ev.id)).body.notifications;
  }
  const names = notes.map((n) => n.recipient).sort();
  check(names.join() === [qc1.name, mt.name].sort().join(), `messages go only to the chosen people (${names.length}: chosen QC + MT member)`);

  const mine = async (c: Client) => ((await c.request("GET", "/api/andons?scope=active&mine=1")).body.events as { id: string }[]).some((e) => e.id === ev.id);
  check((await mine(mt.client)) && (await mine(qc2.client)) && !(await mine(pcl.client)), "'my department' lists: QC and MT see it, PC&L does not");

  const wrong = await transition(pcl.client, ev.id, "ACKNOWLEDGE");
  check(wrong.status === 403 && wrong.body.code === "WRONG_DEPARTMENT", `PC&L member cannot ACK → 403 (${wrong.body.code})`);
  check((await transition(mt.client, ev.id, "ACKNOWLEDGE")).status === 200, "MT member ACKs");
  check((await transition(qc2.client, ev.id, "CLOSE", "[TEST] call test closed")).status === 200, "QC member (not messaged) CLOSEs");

  const noPeople = await createAndon("TGDI1", "WCC Final Inspection", "MAINTENANCE", "[TEST] call: nobody chosen", gap, undefined, { departments: ["MT"], recipients: [] });
  check(noPeople.status === 201, "a department without chosen people is still called (warning in the UI)");
  await sleep(1500);
  const n2 = (await detail(noPeople.body.event.id)).body.notifications;
  check(n2.length === 1 && n2[0].status === "FAILED", "no chosen people → one FAILED 'no recipients' log, nobody messaged");
  await transition(mt.client, noPeople.body.event.id, "CLOSE", "[TEST] cleanup");

  const fallback = await createAndon("TGDI1", "WCC Final Inspection", "QUALITY", "[TEST] call: routing fallback", gap);
  check(fallback.status === 201 && fallback.body.event.departmentCode === "QC" && fallback.body.event.departments.length === 1, "without departments the routing rule decides (QUALITY → QC)");
  await transition(qc1.client, fallback.body.event.id, "CLOSE", "[TEST] cleanup");

  console.log("SITUATIONS / SQA / SV");
  const t2 = (await gap.request("GET", "/api/call-targets?line=AP1-MAIN1")).body;
  const sv = (t2.departments as { code: string; members: { id: number }[]; defaultMemberIds?: number[] }[]).find((d) => d.code === "SV");
  check(t2.departments.some((d: { code: string }) => d.code === "SQA"), "SQA (외주품질) is a callable department");
  check(!!sv && sv.members.length > 0 && (sv.defaultMemberIds ?? []).length === 1 && sv.members.some((m) => m.id === sv.defaultMemberIds![0]), "SV target: production supervisors, the line's supervisor pre-chosen");
  check((t2.situations as { code: string; target: string }[]).length === 21 && t2.situations.some((x: { code: string; target: string }) => x.code === "MT_ROBOT" && x.target === "MT"), "21 plant situations with their call target");
  const sit = await (async () => {
    const f = new FormData();
    f.set("lineCode", "AP1-MAIN1");
    f.set("processId", String((await fetch(`${BASE}/api/meta`).then((r) => r.json())).processes.find((p: { lineCode: string }) => p.lineCode === "AP1-MAIN1").id));
    f.set("categoryCode", "MAINTENANCE");
    f.set("description", "[TEST] call: situations + SV");
    f.set("clientRequestId", `call-sit-${Date.now()}`);
    for (const x of ["MT_ROBOT", "SV_MANPOWER"]) f.append("situations", x);
    for (const x of ["MT", "SV"]) f.append("departments", x);
    for (const x of [mt.id, sv!.defaultMemberIds![0]]) f.append("recipients", String(x));
    return gap.request("POST", "/api/andons", f);
  })();
  check(sit.status === 201 && sit.body.event.situations.join() === "Robot Fault,인원 부족", `situations stored with the event (${sit.body.event?.situations})`);
  check(sit.body.event.departments.map((x: { label: string }) => x.label).join() === "MT · 보전,SV · 생산 감독자", `MT + SV called (${sit.body.event?.departmentLabel})`);
  await transition(mt.client, sit.body.event.id, "CLOSE", "[TEST] cleanup");
  const badSit = await createAndon("TGDI1", "WCC Final Inspection", "QUALITY", "[TEST] call: bad situation", gap, undefined, { departments: ["QC"] });
  check(badSit.status === 201, "situations are optional");
  await transition(qc1.client, badSit.body.event.id, "CLOSE", "[TEST] cleanup");
  const f2 = new FormData();
  for (const [k, v] of Object.entries({ lineCode: "TGDI1", processId: String(badSit.body.event.processId), categoryCode: "QUALITY", description: "[TEST] x", clientRequestId: `call-bad-${Date.now()}` })) f2.set(k, v);
  f2.append("departments", "QC");
  f2.append("situations", "NOPE");
  const rb = await gap.request("POST", "/api/andons", f2);
  check(rb.status === 400 && rb.body.code === "INVALID_SITUATION", `unknown situation → 400 (${rb.body.code})`);
  const f3 = new FormData();
  for (const [k, v] of Object.entries({ lineCode: "TGDI1", processId: String(badSit.body.event.processId), categoryCode: "QUALITY", description: "[TEST] y", clientRequestId: `call-sv-${Date.now()}` })) f3.set(k, v);
  f3.append("departments", "SV");
  const gapId = (await gap.request("GET", "/api/auth/me")).body.user.id;
  f3.append("recipients", String(gapId));
  const rs = await gap.request("POST", "/api/andons", f3);
  check(rs.status === 400 && rs.body.code === "INVALID_RECIPIENT", `SV call to a GAP leader (not a supervisor) → 400 (${rs.body.code})`);

  console.log("MY LINES");
  check(((await gap.request("GET", "/api/call-targets")).body.myLines as string[]).length === 0, "a GAP leader without line assignment: no 'my lines' (all lines shown)");
  const me = (await gap.request("GET", "/api/auth/me")).body.user.id as number;
  admin("assign", "add", "AP1-FRT", "GAP_LEADER", "B", String(me));
  admin("assign", "add", "AP1-MAIN1", "GAP_LEADER", "A", String(me));
  const ml = (await gap.request("GET", "/api/call-targets")).body.myLines as string[];
  check(ml.join() === "AP1-MAIN1,AP1-FRT", `the GAP leader's assigned lines come back, in line order (${ml.join()})`);

  console.log("APPEND-ONLY");
  const { db } = await import("../src/lib/server/db.ts");
  let blocked = 0;
  for (const sql of ["UPDATE andon_event_department SET sort_order = 9 WHERE event_id = ?", "DELETE FROM andon_call_recipient WHERE event_id = ?"]) {
    try {
      await db.run(sql, ev.id);
    } catch {
      blocked++;
    }
  }
  check(blocked === 2, "call departments / recipients cannot be changed afterwards (append-only)");
}

main()
  .then(() => finish())
  .catch((err) => {
    console.error("Test aborted:", err);
    process.exit(1);
  });
