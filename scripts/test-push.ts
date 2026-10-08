// Phone push notification tests (npm run test:push). OFFLINE: a fake push service is served from inside
// this process (fetch is intercepted); payloads are decrypted here exactly like a phone would (RFC 8291).
// Fresh isolated database under work/push-test/ — never Turso, never the live DB.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve("work/push-test", `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`);
fs.mkdirSync(DIR, { recursive: true });
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VAPID_PRIVATE_KEY;
process.env.DATABASE_PATH = path.join(DIR, "push.db");
process.env.UPLOAD_DIR = path.join(DIR, "uploads");
process.env.KAKAO_CLIENT_SECRET = crypto.randomBytes(24).toString("hex"); // VAPID key is derived from it
process.env.NOTIFICATION_PROVIDER = "mock";
process.env.APP_BASE_URL = "https://andon.fake.test";
const PUSH = "https://push.fake.test";
process.env.PUSH_TEST_ENDPOINT_ORIGIN = PUSH;
const BASE = "https://andon.fake.test";

const { db, nowIso } = await import("../src/lib/server/db.ts");
const auth = await import("../src/lib/server/auth.ts");
const wp = await import("../src/lib/server/webPush.ts");
const notify = await import("../src/lib/server/notifications/index.ts");
const andon = await import("../src/lib/server/andonService.ts");

// ---------------------------------------------------------------- fake device + push service
interface Device { endpoint: string; ecdh: crypto.ECDH; auth: Buffer; status: number }
const devices = new Map<string, Device>();
const received: { endpoint: string; headers: Headers; payload: { title: string; body: string; url: string; tag: string | null } }[] = [];

function newDevice(): Device {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const d = { endpoint: `${PUSH}/send/${crypto.randomBytes(8).toString("hex")}`, ecdh, auth: crypto.randomBytes(16), status: 201 };
  devices.set(d.endpoint, d);
  return d;
}
const subJson = (d: Device) => ({ endpoint: d.endpoint, keys: { p256dh: d.ecdh.getPublicKey().toString("base64url"), auth: d.auth.toString("base64url") } });

/** RFC 8291 / 8188 aes128gcm decryption, as the browser does it. */
function decrypt(d: Device, body: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = d.ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), d.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, d.auth, info, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const dec = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  dec.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
  const end = plain.lastIndexOf(2); // padding delimiter
  return plain.subarray(0, end).toString("utf8");
}

const realFetch = globalThis.fetch;
const outside: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(PUSH)) {
    outside.push(url);
    return realFetch(input, init);
  }
  const d = devices.get(url);
  if (!d) return new Response("", { status: 404 });
  const headers = new Headers(init?.headers);
  const body = Buffer.from(init?.body as Uint8Array);
  if (d.status >= 200 && d.status < 300) received.push({ endpoint: url, headers, payload: JSON.parse(decrypt(d, body)) });
  return new Response("", { status: d.status });
};

// ---------------------------------------------------------------- helpers
let passed = 0;
async function check(label: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS ${passed}: ${label}`);
}
const audit = { deviceId: "test-push-device", clientIp: "127.0.0.1", userAgent: "push-test" };
const req = (route: string, cookie = "", origin = BASE) => new Request(BASE + route, { headers: { host: new URL(BASE).host, origin, cookie } });
async function rejectsCode(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (e: { code?: string }) => e.code === code || assert.fail(`expected ${code}, got ${e.code}`));
}
async function newUser(name: string, dept: string) {
  const r = await db.run("INSERT INTO app_user (name, email, department_code, role, active, source, created_at) VALUES (?, NULL, ?, 'RESPONDER', 1, 'REGISTRATION', ?)", name, dept, nowIso());
  const id = Number(r.lastInsertRowid);
  const s = await auth.createSession(id, audit);
  return { id, cookie: `${auth.SESSION_COOKIE}=${s.token}` };
}
const subs = async (userId: number) => (await db.all("SELECT endpoint FROM push_subscription WHERE user_id = ?", userId)).map((r) => r.endpoint as string);

try {
  const p = (await db.get("SELECT p.id, p.line_code FROM process p JOIN line l ON l.code = p.line_code WHERE p.active = 1 AND l.active = 1 ORDER BY p.id LIMIT 1")) as { id: number; line_code: string };
  const cat = (await db.get("SELECT code FROM category WHERE active = 1 ORDER BY code LIMIT 1")) as { code: string };
  const mk = async (d: string) => (await andon.createEvent({ lineCode: p.line_code, processId: p.id, categoryCode: cat.code, description: d, audit })).event;
  const probe = await mk("[TEST] probe");
  const routing = await import("../src/lib/server/routingService.ts");
  const dept = (await db.get("SELECT department_code FROM andon_event WHERE id = ?", probe.id))!.department_code as string;
  const effDept = (await routing.effectiveDepartment(dept)) as string;
  const alice = await newUser("[TEST] Push A", effDept);
  const bob = await newUser("[TEST] Push B", effDept);

  await check("status: configured, VAPID public key (65-byte P-256 point), 0 devices; login required", async () => {
    const s = await wp.pushStatusFor(req("/api/notify/push", alice.cookie));
    assert.equal(s.configured, true);
    assert.equal(Buffer.from(s.publicKey!, "base64url").length, 65);
    assert.equal(s.devices, 0);
    await rejectsCode(() => wp.pushStatusFor(req("/api/notify/push")), "AUTH_REQUIRED");
  });

  const phoneA = newDevice();
  const pcA = newDevice();
  await check("subscribe two devices; invalid endpoint / keys rejected; only browser push services allowed", async () => {
    await wp.subscribeFor(req("/x", alice.cookie), subJson(phoneA));
    await wp.subscribeFor(req("/x", alice.cookie), subJson(pcA));
    await wp.subscribeFor(req("/x", alice.cookie), subJson(pcA)); // same device again → no duplicate
    assert.equal((await subs(alice.id)).length, 2);
    await rejectsCode(() => wp.subscribeFor(req("/x", alice.cookie), { ...subJson(newDevice()), endpoint: "https://evil.example/collect" }), "PUSH_BAD_ENDPOINT");
    await rejectsCode(() => wp.subscribeFor(req("/x", alice.cookie), { ...subJson(newDevice()), endpoint: "http://169.254.169.254/latest" }), "PUSH_BAD_ENDPOINT");
    await rejectsCode(() => wp.subscribeFor(req("/x", alice.cookie), { endpoint: newDevice().endpoint, keys: { p256dh: "x", auth: "y" } }), "PUSH_BAD_KEYS");
    await rejectsCode(() => wp.subscribeFor(req("/x"), subJson(newDevice())), "AUTH_REQUIRED");
    const prev = process.env.PUSH_TEST_ENDPOINT_ORIGIN;
    delete process.env.PUSH_TEST_ENDPOINT_ORIGIN;
    await rejectsCode(() => wp.subscribeFor(req("/x", alice.cookie), subJson(newDevice())), "PUSH_BAD_ENDPOINT");
    process.env.PUSH_TEST_ENDPOINT_ORIGIN = prev;
  });

  await check("test push reaches both devices; VAPID auth, aes128gcm, TTL, urgency high; payload decrypts", async () => {
    received.length = 0;
    const r = await wp.sendPushTest(req("/api/notify/push/test", alice.cookie));
    assert.deepEqual(r, { sent: 2, devices: 2 });
    assert.equal(received.length, 2);
    for (const m of received) {
      assert.match(m.headers.get("authorization") ?? "", /^vapid t=.+, k=.+/);
      assert.equal(m.headers.get("content-encoding"), "aes128gcm");
      assert.equal(m.headers.get("ttl"), "3600");
      assert.equal(m.headers.get("urgency"), "high");
      assert.match(m.payload.title, /테스트/);
    }
    await rejectsCode(() => wp.sendPushTest(req("/x", bob.cookie)), "PUSH_NO_DEVICE");
  });

  await check("ANDON for the department → push to the responder's devices (title, link, tag = event id), logged", async () => {
    received.length = 0;
    const ev = await mk("[TEST] 푸시 알림 확인");
    await notify.notifyAndonCreated(ev);
    const mine = received.filter((m) => devices.get(m.endpoint) === phoneA || devices.get(m.endpoint) === pcA);
    assert.equal(mine.length, 2);
    assert.match(mine[0].payload.title, /\[ANDON 발생\]/);
    assert.ok(mine[0].payload.body.includes(ev.id));
    assert.equal(mine[0].payload.url, `${BASE}/respond/${encodeURIComponent(ev.id)}`);
    assert.equal(mine[0].payload.tag, ev.id);
    const log = await db.all("SELECT provider, recipient, status FROM notification_log WHERE event_id = ? AND provider = 'push'", ev.id);
    assert.ok(log.some((l) => (l.recipient as string).startsWith("[TEST] Push A (2/2)") && l.status === "SENT"), JSON.stringify(log));
    assert.ok(!log.some((l) => (l.recipient as string).startsWith("[TEST] Push B")), "no push log for users without a device");
  });

  await check("device gone (410) → removed; other device still delivered", async () => {
    phoneA.status = 410;
    received.length = 0;
    const r = await wp.sendPushTo(alice.id, { title: "t", body: "b", link: BASE });
    assert.equal(r.sent, 1);
    assert.deepEqual(await subs(alice.id), [pcA.endpoint]);
  });

  await check("push service error does not throw from notifyAndonCreated (logged FAILED)", async () => {
    pcA.status = 500;
    const ev = await mk("[TEST] 푸시 실패");
    await notify.notifyAndonCreated(ev);
    const log = await db.all("SELECT status, error FROM notification_log WHERE event_id = ? AND provider = 'push'", ev.id);
    assert.equal(log.length, 1);
    assert.equal(log[0].status, "FAILED");
    pcA.status = 201;
  });

  await check("same device subscribed by another user moves to that user (shared phone); unsubscribe only own", async () => {
    await wp.subscribeFor(req("/x", bob.cookie), subJson(pcA));
    assert.deepEqual(await subs(alice.id), []);
    assert.deepEqual(await subs(bob.id), [pcA.endpoint]);
    await wp.unsubscribeFor(req("/x", alice.cookie), pcA.endpoint); // not alice's any more → no effect
    assert.deepEqual(await subs(bob.id), [pcA.endpoint]);
    await wp.unsubscribeFor(req("/x", bob.cookie), pcA.endpoint);
    assert.deepEqual(await subs(bob.id), []);
  });

  await check("subscription rotation (oldEndpoint) replaces the old row", async () => {
    const a = newDevice(), b = newDevice();
    await wp.subscribeFor(req("/x", bob.cookie), subJson(a));
    await wp.subscribeFor(req("/x", bob.cookie), subJson(b), a.endpoint);
    assert.deepEqual(await subs(bob.id), [b.endpoint]);
  });

  await check("no push request left this process", async () => {
    assert.deepEqual(outside, []);
  });
  console.log(`\nALL ${passed} PUSH CHECKS PASSED`);
  process.exit(0);
} catch (err) {
  console.error("FAILED:", err);
  process.exit(1);
}
