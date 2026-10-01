// End-to-end API test of the Golden Path against a running server.
// Usage: npm run test:golden          (server must be running; BASE_URL defaults to http://localhost:3000)
// Creates one real test ANDON (description starts with "[TEST]").
export {}; // module scope: keeps this script's declarations out of the global namespace

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

let failures = 0;
function check(cond: unknown, label: string) {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.log(`  ✖ ${label}`);
  }
}

async function json(res: Response) {
  return res.json().catch(() => null);
}

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function main() {
  console.log(`Golden Path test → ${BASE}`);

  const health = await fetch(`${BASE}/api/health`).then(json);
  check(health?.ok === true, "health check OK");

  const meta = await fetch(`${BASE}/api/meta`).then(json);
  const line = meta.lines.find((l: { code: string }) => l.code === "TGDI1");
  const proc = meta.processes.find((p: { lineCode: string; name: string }) => p.lineCode === "TGDI1" && p.name === "WCC Final Inspection");
  check(line && proc, "master data has T-GDI 1 / WCC Final Inspection");

  const before = await fetch(`${BASE}/api/stats?days=1`).then(json);

  console.log("1) Create ANDON");
  const requestId = `test-${Date.now()}`;
  const form = () => {
    const f = new FormData();
    f.set("lineCode", "TGDI1");
    f.set("processId", String(proc.id));
    f.set("categoryCode", "QUALITY");
    f.set("description", "[TEST] Stay Bracket 체결 이상 발견");
    f.set("createdBy", "golden-path-test");
    f.set("clientRequestId", requestId);
    f.set("photo", new Blob([PNG], { type: "image/png" }), "test.png");
    return f;
  };
  const createRes = await fetch(`${BASE}/api/andons`, { method: "POST", body: form() });
  const created = await json(createRes);
  check(createRes.status === 201, `POST /api/andons → 201 (got ${createRes.status})`);
  const id: string = created?.event?.id;
  check(/^AND-\d{8}-\d{3}$/.test(id ?? ""), `ANDON id format (${id})`);
  check(created?.event?.status === "OPEN", "status OPEN (RED)");
  check(created?.event?.departmentCode === "QUALITY", "routed to QUALITY department");

  console.log("2) Duplicate submission is idempotent");
  const dupRes = await fetch(`${BASE}/api/andons`, { method: "POST", body: form() });
  const dup = await json(dupRes);
  check(dupRes.status === 200 && dup?.duplicate === true && dup?.event?.id === id, "same clientRequestId returns same event");

  console.log("3) Validation");
  const bad = new FormData();
  bad.set("lineCode", "TGDI1");
  bad.set("processId", String(proc.id));
  bad.set("categoryCode", "QUALITY");
  bad.set("description", "   ");
  const badRes = await fetch(`${BASE}/api/andons`, { method: "POST", body: bad });
  check(badRes.status === 400, `empty description rejected with 400 (got ${badRes.status})`);

  console.log("4) Dashboard shows the event as RED");
  const board = await fetch(`${BASE}/api/andons?scope=board`).then(json);
  const onBoard = board.events.find((e: { id: string }) => e.id === id);
  check(onBoard?.status === "OPEN", "event on board with status OPEN");
  check(typeof board.serverTime === "string" && board.counts.open >= 1, "board returns serverTime and counts");

  console.log("5) Photo is stored and served");
  const photoRes = await fetch(`${BASE}/api/photos/${created.event.photoFile}`);
  check(photoRes.status === 200 && photoRes.headers.get("content-type") === "image/png", "photo served as image/png");
  const traversal = await fetch(`${BASE}/api/photos/..%2Fandon.db`);
  check(traversal.status === 404, "photo path traversal blocked");

  await new Promise((r) => setTimeout(r, 300));
  const detail0 = await fetch(`${BASE}/api/andons/${id}`).then(json);
  check(detail0.notifications.length >= 1 && detail0.notifications.every((n: { status: string }) => n.status === "SENT"), `notification logged (${detail0.notifications.length} recipient(s))`);

  const transition = (action: string, userName: string, comment?: string) =>
    fetch(`${BASE}/api/andons/${id}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, userName, comment }),
    });

  console.log("6) CLOSE before ACK is rejected");
  const early = await transition("CLOSE", "품질 담당 A", "x");
  check(early.status === 409, `CLOSE on OPEN → 409 (got ${early.status})`);

  console.log("7) ACKNOWLEDGE → YELLOW");
  const ack = await transition("ACKNOWLEDGE", "품질 담당 A");
  const ackBody = await json(ack);
  check(ack.status === 200 && ackBody.event.status === "ACKNOWLEDGED", "status ACKNOWLEDGED");
  check(ackBody.event.acknowledgedBy === "품질 담당 A" && ackBody.event.acknowledgedAt, "acknowledgedBy / acknowledgedAt stored");
  const ack2 = await transition("ACKNOWLEDGE", "품질 담당 B");
  check(ack2.status === 409, "second ACKNOWLEDGE rejected (409)");

  console.log("8) ACTION → IN_PROGRESS");
  const noComment = await transition("ACTION", "품질 담당 A", "");
  check(noComment.status === 400, "ACTION without comment rejected (400)");
  const act = await transition("ACTION", "품질 담당 A", "체결 토크 확인 중");
  check(act.status === 200 && (await json(act)).event.status === "IN_PROGRESS", "status IN_PROGRESS");

  console.log("9) CLOSE → GREEN");
  const close = await transition("CLOSE", "품질 담당 A", "[TEST] 볼트 재체결 및 전수검사 OK");
  const closed = await json(close);
  check(close.status === 200 && closed.event.status === "CLOSED", "status CLOSED");
  check(closed.event.correctiveAction?.includes("재체결"), "corrective action stored");
  const after = await transition("ACTION", "품질 담당 A", "late");
  check(after.status === 409, "no actions allowed after CLOSE (409)");

  console.log("10) Complete history persisted");
  const detail = await fetch(`${BASE}/api/andons/${id}`).then(json);
  const path = detail.transitions.map((t: { action: string; fromStatus: string | null; toStatus: string }) => `${t.action}:${t.fromStatus ?? "-"}>${t.toStatus}`);
  console.log(`     ${path.join("  ")}`);
  check(
    path.join(",") === "CREATE:->OPEN,ACKNOWLEDGE:OPEN>ACKNOWLEDGED,ACTION:ACKNOWLEDGED>IN_PROGRESS,CLOSE:IN_PROGRESS>CLOSED",
    "4 transitions with correct from/to states",
  );
  check(detail.transitions.every((t: { userName: string; createdAt: string }) => t.userName && t.createdAt), "every transition has user + timestamp");

  console.log("11) Statistics updated");
  const stats = await fetch(`${BASE}/api/stats?days=1`).then(json);
  check(stats.total === before.total + 1, `total ${before.total} → ${stats.total}`);
  check(stats.closed === before.closed + 1, `closed ${before.closed} → ${stats.closed}`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test aborted:", err);
  process.exit(1);
});
