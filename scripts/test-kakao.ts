// KakaoTalk "send to me" notification tests (npm run test:kakao). OFFLINE: a fake Kakao (OAuth + API) is
// served from inside this process; no real Kakao key, account or network is used. Fresh isolated database
// under work/kakao-test/ — never Turso, never the live DB.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve("work/kakao-test", `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`);
fs.mkdirSync(DIR, { recursive: true });
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.KAKAO_REDIRECT_URI;
process.env.DATABASE_PATH = path.join(DIR, "kakao.db");
process.env.UPLOAD_DIR = path.join(DIR, "uploads");
// Explicitly fake, process-local values. No .env writes.
process.env.KAKAO_REST_API_KEY = "fake-rest-key";
process.env.KAKAO_CLIENT_SECRET = crypto.randomBytes(24).toString("hex");
process.env.KAKAO_AUTH_BASE = "https://kauth.fake.test";
process.env.KAKAO_API_BASE = "https://kapi.fake.test";
process.env.NOTIFICATION_PROVIDER = "kakao";
process.env.APP_BASE_URL = "https://andon.fake.test";
const BASE = "https://andon.fake.test";

const { db, nowIso } = await import("../src/lib/server/db.ts");
const auth = await import("../src/lib/server/auth.ts");
const kn = await import("../src/lib/server/kakaoNotify.ts");
const kakao = await import("../src/lib/server/kakao.ts");
const notify = await import("../src/lib/server/notifications/index.ts");
const andon = await import("../src/lib/server/andonService.ts");

// ---------------------------------------------------------------- fake Kakao
type Grant = { kakaoId: string; scope: string };
const codes = new Map<string, Grant>();
const access = new Map<string, string>(); // access token → kakao id
const refresh = new Map<string, string>(); // refresh token → kakao id
const memos: { kakaoId: string; template: { text: string; link: { web_url: string } } }[] = [];
const unlinked: string[] = [];
const issued: string[] = []; // every token value handed out (for the "not stored in plain text" check)
let refreshFails = false;
let lastRedirect = "";
const tok = (p: string) => {
  const t = `${p}-${crypto.randomBytes(12).toString("hex")}`;
  issued.push(t);
  return t;
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
  const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
  if (url.origin === "https://kauth.fake.test" && url.pathname === "/oauth/token") {
    if (form.get("client_id") !== "fake-rest-key" || form.get("client_secret") !== process.env.KAKAO_CLIENT_SECRET) return Response.json({ error: "invalid_client" }, { status: 401 });
    if (form.get("grant_type") === "authorization_code") {
      lastRedirect = form.get("redirect_uri") ?? "";
      const g = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!g) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const a = tok("access"), r = tok("refresh");
      access.set(a, g.kakaoId);
      refresh.set(r, g.kakaoId);
      return Response.json({ token_type: "bearer", access_token: a, expires_in: 21599, refresh_token: r, refresh_token_expires_in: 5183999, scope: g.scope });
    }
    if (form.get("grant_type") === "refresh_token") {
      const id = refresh.get(form.get("refresh_token") ?? "");
      if (!id || refreshFails) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const a = tok("access");
      access.set(a, id);
      return Response.json({ token_type: "bearer", access_token: a, expires_in: 21599 }); // no new refresh token
    }
  }
  if (url.origin === "https://kapi.fake.test") {
    const id = access.get(bearer);
    if (!id) return Response.json({ msg: "this access token does not exist", code: -401 }, { status: 401 });
    if (url.pathname === "/v2/user/me") return Response.json({ id: Number(id) });
    if (url.pathname === "/v2/api/talk/memo/default/send") {
      memos.push({ kakaoId: id, template: JSON.parse(form.get("template_object") ?? "{}") });
      return Response.json({ result_code: 0 });
    }
    if (url.pathname === "/v1/user/unlink") {
      unlinked.push(id);
      for (const [k, v] of access) if (v === id) access.delete(k);
      return Response.json({ id: Number(id) });
    }
  }
  return realFetch(input, init);
};

// ---------------------------------------------------------------- helpers
let passed = 0;
async function check(label: string, fn: () => unknown | Promise<unknown>) {
  await fn();
  passed++;
  console.log(`PASS ${passed}: ${label}`);
}
const audit = { deviceId: "test-kakao-device", clientIp: "127.0.0.1", userAgent: "kakao-test" };
const req = (route: string, cookie = "") => new Request(BASE + route, { headers: { host: new URL(BASE).host, origin: BASE, cookie } });
async function rejectsCode(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (e: { code?: string }) => e.code === code || assert.fail(`expected ${code}, got ${e.code}`));
}
async function newUser(name: string, dept: string) {
  const r = await db.run("INSERT INTO app_user (name, email, department_code, role, active, source, created_at) VALUES (?, NULL, ?, 'RESPONDER', 1, 'REGISTRATION', ?)", name, dept, nowIso());
  const id = Number(r.lastInsertRowid);
  const s = await auth.createSession(id, audit);
  return { id, cookie: `${auth.SESSION_COOKIE}=${s.token}` };
}
/** start → fake Kakao consent → callback. Returns the callback Request parts for replay tests. */
async function link(user: { cookie: string }, kakaoId: string, scope = "talk_message", callbackCookie = user.cookie) {
  const { url } = await kn.beginKakaoLink(req("/api/notify/kakao/start", user.cookie));
  const u = new URL(url);
  const code = `code-${crypto.randomBytes(6).toString("hex")}`;
  codes.set(code, { kakaoId, scope });
  const cb = `/api/notify/kakao/callback?code=${code}&state=${encodeURIComponent(u.searchParams.get("state")!)}`;
  return { authorizeUrl: u, cb, done: kn.completeKakaoLink(req(cb, callbackCookie)) };
}
const logs = async (eventId: string) => (await db.all("SELECT recipient, status, error FROM notification_log WHERE event_id = ? ORDER BY id", eventId)) as { recipient: string; status: string; error: string | null }[];

try {
  // An ANDON on the first active line decides which department the test responders belong to.
  const p = (await db.get("SELECT p.id, p.line_code FROM process p JOIN line l ON l.code = p.line_code WHERE p.active = 1 AND l.active = 1 ORDER BY p.id LIMIT 1")) as { id: number; line_code: string };
  const cat = (await db.get("SELECT code FROM category WHERE active = 1 ORDER BY code LIMIT 1")) as { code: string };
  const mk = async (d: string) => (await andon.createEvent({ lineCode: p.line_code, processId: p.id, categoryCode: cat.code, description: d, audit })).event;
  const probe = await mk("[TEST] probe");
  const routing = await import("../src/lib/server/routingService.ts");
  const dept = (await db.get("SELECT department_code FROM andon_event WHERE id = ?", probe.id))!.department_code as string;
  // primaryRecipients uses the EFFECTIVE department; create the users there.
  const effDept = (await routing.effectiveDepartment(dept)) as string;
  const alice = await newUser("[TEST] Kakao A", effDept);
  const bob = await newUser("[TEST] Kakao B", effDept);
  const carol = await newUser("[TEST] Kakao C", effDept);

  await check("encryption round trip; ciphertext differs per call and is tamper-evident", () => {
    const cfg = kakao.kakaoConfig()!;
    const a = kakao.encryptToken(cfg, "secret-token"), b = kakao.encryptToken(cfg, "secret-token");
    assert.notEqual(a, b);
    assert.ok(!a.includes("secret-token"));
    assert.equal(kakao.decryptToken(cfg, a), "secret-token");
    const parts = a.split(":");
    parts[3] = Buffer.from("x" + Buffer.from(parts[3], "base64url").toString("latin1"), "latin1").toString("base64url");
    assert.throws(() => kakao.decryptToken(cfg, parts.join(":")));
  });
  await check("200-char text limit keeps the full link", () => {
    const t = notify.kakaoText({ title: "[ANDON 발생] L / P", body: "x".repeat(400), link: `${BASE}/respond/AND-20261003-001` });
    assert.ok(t.length <= 200);
    assert.ok(t.endsWith(`${BASE}/respond/AND-20261003-001`));
  });
  await check("not logged in → 401 on start and status", async () => {
    await rejectsCode(() => kn.beginKakaoLink(req("/api/notify/kakao/start")), "AUTH_REQUIRED");
    await rejectsCode(() => kn.kakaoStatusFor(req("/api/notify/kakao")), "AUTH_REQUIRED");
  });

  const first = await link(alice, "9000001");
  await check("authorize URL: talk_message scope, own callback, random state", () => {
    assert.equal(first.authorizeUrl.origin + first.authorizeUrl.pathname, "https://kauth.fake.test/oauth/authorize");
    assert.equal(first.authorizeUrl.searchParams.get("scope"), "talk_message");
    assert.equal(first.authorizeUrl.searchParams.get("client_id"), "fake-rest-key");
    assert.equal(first.authorizeUrl.searchParams.get("redirect_uri"), `${BASE}/api/notify/kakao/callback`);
    assert.ok(first.authorizeUrl.searchParams.get("state")!.length >= 40);
  });
  await first.done;
  await check("link success: confirmation memo delivered, channel verified, status active", async () => {
    assert.equal(lastRedirect, `${BASE}/api/notify/kakao/callback`);
    assert.equal(memos.length, 1);
    assert.equal(memos[0].kakaoId, "9000001");
    assert.match(memos[0].template.text, /연결되었습니다/);
    const ch = await db.get("SELECT recipient_id, verified, active FROM user_notification_channel WHERE user_id = ? AND provider = 'KAKAO'", alice.id);
    assert.deepEqual({ ...ch }, { recipient_id: "9000001", verified: 1, active: 1 });
    const st = await kn.kakaoStatus(alice.id);
    assert.equal(st.linked && st.active, true);
  });
  await check("tokens are not stored in plain text; status exposes no token / Kakao id", async () => {
    const row = JSON.stringify(await db.get("SELECT * FROM kakao_link WHERE user_id = ?", alice.id));
    for (const t of issued) assert.ok(!row.includes(t));
    const st = JSON.stringify(await kn.kakaoStatusFor(req("/api/notify/kakao", alice.cookie)));
    assert.ok(!st.includes("9000001") && !issued.some((t) => st.includes(t)));
  });
  await check("callback replay rejected (state is one-time)", () => rejectsCode(() => kn.completeKakaoLink(req(first.cb, alice.cookie)), "KAKAO_INVALID_STATE"));
  await check("forged / missing state rejected", async () => {
    await rejectsCode(() => kn.completeKakaoLink(req("/api/notify/kakao/callback?code=x&state=forged", alice.cookie)), "KAKAO_INVALID_STATE");
    await rejectsCode(() => kn.completeKakaoLink(req("/api/notify/kakao/callback?code=x", alice.cookie)), "KAKAO_INVALID_STATE");
  });
  await check("callback in another user's session rejected (no link created)", async () => {
    const x = await link(bob, "9000002", "talk_message", carol.cookie);
    await rejectsCode(() => x.done, "KAKAO_SESSION_CHANGED");
    assert.equal(await db.get("SELECT 1 FROM kakao_link WHERE user_id IN (?, ?)", bob.id, carol.id), undefined);
  });
  await check("same user, different session (re-login) rejected", async () => {
    const other = await auth.createSession(bob.id, audit);
    const x = await link(bob, "9000002", "talk_message", `${auth.SESSION_COOKIE}=${other.token}`);
    await rejectsCode(() => x.done, "KAKAO_SESSION_CHANGED");
  });
  await check("expired flow rejected", async () => {
    const { url } = await kn.beginKakaoLink(req("/api/notify/kakao/start", bob.cookie));
    await db.run("UPDATE kakao_link_flow SET expires_at = ? WHERE user_id = ?", new Date(Date.now() - 1000).toISOString(), bob.id);
    codes.set("code-exp", { kakaoId: "9000002", scope: "talk_message" });
    await rejectsCode(() => kn.completeKakaoLink(req(`/api/notify/kakao/callback?code=code-exp&state=${new URL(url).searchParams.get("state")}`, bob.cookie)), "KAKAO_INVALID_STATE");
    assert.equal(await db.get("SELECT 1 FROM kakao_link WHERE user_id = ?", bob.id), undefined);
  });
  await check("talk_message consent declined → not linked", async () => {
    const x = await link(bob, "9000002", "profile_nickname");
    await rejectsCode(() => x.done, "KAKAO_SCOPE_MISSING");
    assert.equal(await db.get("SELECT 1 FROM user_notification_channel WHERE user_id = ?", bob.id), undefined);
  });
  await check("user cancels on Kakao (error=access_denied) → not linked", async () => {
    const { url } = await kn.beginKakaoLink(req("/api/notify/kakao/start", bob.cookie));
    await rejectsCode(() => kn.completeKakaoLink(req(`/api/notify/kakao/callback?error=access_denied&state=${new URL(url).searchParams.get("state")}`, bob.cookie)), "KAKAO_DENIED");
  });
  await check("a Kakao account already linked to another employee is refused", async () => {
    const x = await link(bob, "9000001");
    await rejectsCode(() => x.done, "KAKAO_ALREADY_LINKED");
    assert.equal((await db.get("SELECT user_id FROM kakao_link WHERE kakao_user_id = '9000001'"))!.user_id, alice.id);
  });
  await check("a typed / unverified KAKAO channel is never used for sending", async () => {
    await db.run("INSERT INTO user_notification_channel (user_id, provider, recipient_id, verified, active, created_at) VALUES (?, 'KAKAO', 'typed-id', 0, 1, ?)", carol.id, nowIso());
    await assert.rejects(() => kn.sendKakaoMemoTo(carol.id, "x", BASE), /KAKAO_NOT_LINKED/);
    await db.run("DELETE FROM user_notification_channel WHERE recipient_id = 'typed-id'");
  });

  const ev = await mk("[TEST] Kakao 알림 확인");
  const before = memos.length;
  await notify.notifyAndonCreated(ev);
  await check("ANDON created → memo to the linked responder with the event link; unlinked responders FAILED", async () => {
    const sent = memos.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kakaoId, "9000001");
    assert.ok(sent[0].template.text.includes(ev.id));
    assert.equal(sent[0].template.link.web_url, `${BASE}/respond/${ev.id}`);
    assert.ok(sent[0].template.text.length <= 200);
    const l = await logs(ev.id);
    assert.deepEqual(l.find((x) => x.recipient === "[TEST] Kakao A")?.status, "SENT");
    for (const n of ["[TEST] Kakao B", "[TEST] Kakao C"]) {
      const f = l.find((x) => x.recipient === n)!;
      assert.equal(f.status, "FAILED");
      assert.match(f.error!, /미연결/);
    }
    assert.ok(!issued.some((t) => JSON.stringify(l).includes(t)), "no token in notification_log");
  });
  await check("expired access token → refreshed transparently, memo sent, refresh token kept", async () => {
    const old = (await db.get("SELECT refresh_token_enc FROM kakao_link WHERE user_id = ?", alice.id))!.refresh_token_enc;
    await db.run("UPDATE kakao_link SET access_expires_at = ? WHERE user_id = ?", new Date(Date.now() - 60_000).toISOString(), alice.id);
    const e2 = await mk("[TEST] refresh");
    await notify.notifyAndonCreated(e2);
    assert.equal((await logs(e2.id)).find((x) => x.recipient === "[TEST] Kakao A")?.status, "SENT");
    const row = (await db.get("SELECT access_expires_at, refresh_token_enc FROM kakao_link WHERE user_id = ?", alice.id))!;
    assert.ok(String(row.access_expires_at) > nowIso());
    assert.equal(row.refresh_token_enc, old);
  });
  await check("refresh fails → FAILED log, link marked 'link again', ANDON creation unaffected", async () => {
    refreshFails = true;
    await db.run("UPDATE kakao_link SET access_expires_at = ? WHERE user_id = ?", new Date(Date.now() - 60_000).toISOString(), alice.id);
    const e3 = await mk("[TEST] refresh fails");
    assert.equal(e3.status, "OPEN");
    await notify.notifyAndonCreated(e3); // must not throw
    const f = (await logs(e3.id)).find((x) => x.recipient === "[TEST] Kakao A")!;
    assert.equal(f.status, "FAILED");
    assert.match(f.error!, /REFRESH/);
    const st = await kn.kakaoStatus(alice.id);
    assert.equal(st.linked, true);
    assert.equal(st.active, false);
    // next ANDON: no longer even tried (unverified channel)
    const e4 = await mk("[TEST] after failed refresh");
    await notify.notifyAndonCreated(e4);
    assert.match((await logs(e4.id)).find((x) => x.recipient === "[TEST] Kakao A")!.error!, /미연결/);
    refreshFails = false;
  });
  await check("re-link after a failed refresh restores the channel", async () => {
    await (await link(alice, "9000001")).done;
    assert.equal((await kn.kakaoStatus(alice.id)).active, true);
  });
  await check("test endpoint sends a memo to the own chat only", async () => {
    const n = memos.length;
    await kn.sendKakaoTest(req("/api/notify/kakao/test", alice.cookie));
    assert.equal(memos.length, n + 1);
    assert.equal(memos.at(-1)!.kakaoId, "9000001");
    await rejectsCode(() => kn.sendKakaoTest(req("/api/notify/kakao/test", bob.cookie)), "KAKAO_SEND_FAILED");
  });
  await check("token revoked on Kakao's side (401) → link marked 'link again'", async () => {
    access.clear();
    await rejectsCode(() => kn.sendKakaoTest(req("/api/notify/kakao/test", alice.cookie)), "KAKAO_SEND_FAILED");
    assert.equal((await kn.kakaoStatus(alice.id)).active, false);
    await (await link(alice, "9000001")).done;
  });
  await check("unlink: Kakao unlink called, tokens and channel removed", async () => {
    await kn.unlinkKakaoFor(req("/api/notify/kakao/unlink", alice.cookie));
    assert.ok(unlinked.includes("9000001"));
    assert.equal(await db.get("SELECT 1 FROM kakao_link WHERE user_id = ?", alice.id), undefined);
    assert.equal(await db.get("SELECT 1 FROM user_notification_channel WHERE user_id = ? AND provider = 'KAKAO'", alice.id), undefined);
    assert.equal((await kn.kakaoStatus(alice.id)).linked, false);
  });
  await check("after unlink the same Kakao account can be linked by another employee", async () => {
    await (await link(bob, "9000001")).done;
    assert.equal((await db.get("SELECT user_id FROM kakao_link WHERE kakao_user_id = '9000001'"))!.user_id, bob.id);
  });
  await check("recipients: HSE / ME / MT / QC / PC&L notify every member that may respond (team leader incl.); UAP only RESPONDERs", async () => {
    const mk2 = async (dept: string, role: string) =>
      Number((await db.run("INSERT INTO app_user (name, department_code, role, active, source, created_at) VALUES (?, ?, ?, 1, 'ADMIN', ?)", `[TEST] ${dept} ${role}`, dept, role, nowIso())).lastInsertRowid);
    const ids = { qcEng: await mk2("QC", "ENGINEER"), mtGap: await mk2("MT", "GAP_LEADER"), meSup: await mk2("ME", "SUPERVISOR"), qcOp: await mk2("QC", "OPERATOR"), uapGap: await mk2("UAP", "GAP_LEADER"), pclEng: await mk2("PCL", "ENGINEER") };
    const has = async (dept: string, id: number) => (await routing.primaryRecipients(dept)).some((r) => r.id === id);
    assert.equal(await has("QC", ids.qcEng), true);
    assert.equal(await has("MT", ids.mtGap), true);
    assert.equal(await has("ME", ids.meSup), true);
    assert.equal(await has("QC", ids.qcOp), false, "operators never");
    assert.equal(await has("UAP", ids.uapGap), false);
    assert.equal(await has("PCL", ids.pclEng), true);
    await db.run(`UPDATE app_user SET active = 0 WHERE id IN (${Object.values(ids).join(",")})`);
  });
  // ---- self-service password reset with a code sent to the own KakaoTalk (bob is linked to 9000001 now)
  const reset = await import("../src/lib/server/passwordReset.ts");
  const ra = { deviceId: null, clientIp: "10.0.0.9", userAgent: "reset-test" };
  const bobLogin = `bob-${crypto.randomBytes(3).toString("hex")}@andon.test`;
  await db.run("INSERT INTO user_identity (user_id, provider, subject, password_hash, created_at) VALUES (?, 'LOCAL', ?, ?, ?)", bob.id, bobLogin, await auth.hashPassword("OldPass123"), nowIso());
  await db.run("INSERT INTO user_identity (user_id, provider, subject, password_hash, created_at) VALUES (?, 'LOCAL', ?, ?, ?)", carol.id, `carol-${bobLogin}`, await auth.hashPassword("OldPass123"), nowIso());
  const lastCode = () => /인증번호: (\d{6})/.exec(memos.at(-1)?.template.text ?? "")?.[1];
  await check("reset: unknown login / login without Kakao → same answer, nothing sent", async () => {
    const n = memos.length;
    const a = await reset.requestPasswordReset("nobody@andon.test", BASE, ra);
    const b = await reset.requestPasswordReset(`carol-${bobLogin}`, BASE, ra);
    assert.equal(a, b);
    assert.equal(memos.length, n);
    assert.equal(await db.get("SELECT 1 FROM password_reset_code WHERE user_id = ?", carol.id), undefined);
  });
  await check("reset: code goes to the own KakaoTalk only; only its hash is stored", async () => {
    await reset.requestPasswordReset(bobLogin, BASE, ra);
    const code = lastCode()!;
    assert.match(code, /^\d{6}$/);
    assert.equal(memos.at(-1)!.kakaoId, "9000001");
    const row = (await db.get("SELECT code_hash FROM password_reset_code WHERE user_id = ?", bob.id))!;
    assert.ok(!String(row.code_hash).includes(code));
  });
  await check("reset: wrong code rejected; right code sets the new password and ends all sessions", async () => {
    const code = lastCode()!;
    const wrong = code === "000000" ? "111111" : "000000";
    await rejectsCode(() => reset.confirmPasswordReset({ login: bobLogin, code: wrong, newPassword: "NewPass456", newPasswordConfirm: "NewPass456" }, ra), "INVALID_RESET_CODE");
    await rejectsCode(() => reset.confirmPasswordReset({ login: bobLogin, code, newPassword: "short", newPasswordConfirm: "short" }, ra), "INVALID_PASSWORD");
    await reset.confirmPasswordReset({ login: bobLogin, code, newPassword: "NewPass456", newPasswordConfirm: "NewPass456" }, ra);
    assert.equal((await auth.authenticate(bobLogin, "NewPass456", ra)).id, bob.id);
    await assert.rejects(() => auth.authenticate(bobLogin, "OldPass123", { ...ra, clientIp: "10.0.0.10" }));
    assert.equal(await auth.getSessionUser(req("/", bob.cookie)), null, "old session ended");
    await rejectsCode(() => reset.confirmPasswordReset({ login: bobLogin, code, newPassword: "Again789x", newPasswordConfirm: "Again789x" }, ra), "INVALID_RESET_CODE");
  });
  await check("reset: works with the 사번 too; expired code rejected", async () => {
    await db.run("UPDATE app_user SET employee_id = ? WHERE id = ?", "77001234", bob.id);
    await reset.requestPasswordReset("77001234", BASE, ra);
    const code = lastCode()!;
    await db.run("UPDATE password_reset_code SET expires_at = ? WHERE user_id = ?", new Date(Date.now() - 1000).toISOString(), bob.id);
    await rejectsCode(() => reset.confirmPasswordReset({ login: "77001234", code, newPassword: "Emp12345x", newPasswordConfirm: "Emp12345x" }, ra), "INVALID_RESET_CODE");
    await reset.requestPasswordReset("77001234", BASE, ra);
    await reset.confirmPasswordReset({ login: "77001234", code: lastCode()!, newPassword: "Emp12345x", newPasswordConfirm: "Emp12345x" }, ra);
    assert.equal((await auth.authenticate("77001234", "Emp12345x", ra)).id, bob.id);
  });
  await check("reset: after 5 wrong codes even the right code is refused", async () => {
    await reset.requestPasswordReset(bobLogin, BASE, { ...ra, clientIp: "10.0.0.11" });
    const code = lastCode()!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await reset.confirmPasswordReset({ login: bobLogin, code: wrong, newPassword: "Lock1234x", newPasswordConfirm: "Lock1234x" }, { ...ra, clientIp: `10.0.1.${i}` }).catch(() => {});
    }
    await rejectsCode(() => reset.confirmPasswordReset({ login: bobLogin, code, newPassword: "Lock1234x", newPasswordConfirm: "Lock1234x" }, { ...ra, clientIp: "10.0.2.1" }), "INVALID_RESET_CODE");
  });
  await check("not configured → 503 and status configured=false", async () => {
    const k = process.env.KAKAO_REST_API_KEY;
    delete process.env.KAKAO_REST_API_KEY;
    await rejectsCode(() => kn.beginKakaoLink(req("/api/notify/kakao/start", bob.cookie)), "KAKAO_NOT_CONFIGURED");
    assert.equal((await kn.kakaoStatus(bob.id)).configured, false);
    process.env.KAKAO_REST_API_KEY = k;
  });
  console.log(`\nAll ${passed} Kakao checks passed. (isolated DB: ${path.relative(process.cwd(), DIR)})`);
} catch (err) {
  console.error(`\nFAILED after ${passed} checks:`, err);
  process.exitCode = 1;
}
