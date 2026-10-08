// Reliability tests against a running server (npm run test:reliability).
// H1: a problem with the optional photo must never block the ANDON call.
// Creates real test ANDONs (description starts with "[TEST]") and closes them again.
// Responder steps (closing the test events) use a throw-away MT account (scripts/lib/testkit.ts).
import { admin, callerClient, registerAccount } from "./lib/testkit.ts";

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

let failures = 0;
function check(cond: unknown, label: string) {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.log(`  ✖ ${label}`);
  }
}

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface CreateResponse {
  event?: { id: string; status: string; photoFile: string | null };
  duplicate?: boolean;
  photoWarning?: string | null;
  error?: string;
}

async function main() {
  console.log(`Reliability test → ${BASE}`);
  const meta = await fetch(`${BASE}/api/meta`).then((r) => r.json());
  const proc = meta.processes.find((p: { lineCode: string }) => p.lineCode === "TGDI1");

  const created: string[] = [];
  async function call(label: string, photo: Blob | null) {
    const f = new FormData();
    f.set("lineCode", "TGDI1");
    f.set("processId", String(proc.id));
    f.set("categoryCode", "MAINTENANCE");
    f.set("description", `[TEST] reliability: ${label}`);
    f.set("createdBy", "reliability-test");
    f.set("clientRequestId", `rel-${Date.now()}-${Math.random()}`);
    if (photo) f.set("photo", photo, "photo");
    const res = await fetch(`${BASE}/api/andons`, { method: "POST", body: f, headers: (await callerClient()).headers() });
    const body = (await res.json().catch(() => ({}))) as CreateResponse;
    if (body.event?.id) created.push(body.event.id);
    return { status: res.status, body };
  }

  console.log("H1) Photo problems never block the ANDON call");
  const cases: [string, Blob][] = [
    ["unsupported type (GIF)", new Blob([new Uint8Array(100)], { type: "image/gif" })],
    ["missing MIME type", new Blob([new Uint8Array(100)], { type: "" })],
    ["too large (12 MB)", new Blob([new Uint8Array(12 * 1024 * 1024)], { type: "image/jpeg" })],
  ];
  for (const [label, blob] of cases) {
    const r = await call(label, blob);
    check(
      r.status === 201 && r.body.event?.status === "OPEN" && r.body.event.photoFile === null && !!r.body.photoWarning,
      `${label}: ANDON created (RED) without photo, warning returned (HTTP ${r.status}: ${r.body.photoWarning ?? r.body.error})`,
    );
  }
  const ok = await call("valid photo", new Blob([PNG], { type: "image/png" }));
  check(ok.status === 201 && !!ok.body.event?.photoFile && !ok.body.photoWarning, "valid photo is still attached, no warning");
  const none = await call("no photo", null);
  check(none.status === 201 && none.body.event?.photoFile === null && !none.body.photoWarning, "no photo: created, no warning");

  // Close the test events (category MAINTENANCE → MT) so they do not stay RED on the dashboard.
  const mt = await registerAccount("MT", "reliability");
  for (const id of created) {
    const t = (action: string, comment?: string) =>
      fetch(`${BASE}/api/andons/${id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...mt.client.headers() },
        body: JSON.stringify({ action, comment }),
      });
    await t("ACKNOWLEDGE");
    await t("CLOSE", "[TEST] reliability test cleanup");
  }
  const board = await fetch(`${BASE}/api/andons?scope=active`).then((r) => r.json());
  check(!board.events.some((e: { id: string }) => created.includes(e.id)), `test events closed again (${created.length})`);

  admin("user", "deactivate-test-accounts");
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test aborted:", err);
  process.exit(1);
});
