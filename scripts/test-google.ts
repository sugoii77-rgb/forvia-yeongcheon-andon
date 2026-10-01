// Offline OIDC integration + real ANDON API authorization tests. NO real Google credentials used.
// Run against a separate test server whose health endpoint reports the same work/ DB.
//   BASE_URL=http://localhost:3101 DATABASE_PATH=work/google/<copy>.db npm run test:google
// (Originally written by Astra; rewritten for the async database API — same 48 checks.)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import * as jose from "jose";
import * as oidc from "openid-client";

if (!process.env.DATABASE_PATH || !path.resolve(process.env.DATABASE_PATH).startsWith(path.resolve("work") + path.sep)) {
  throw new Error("test:google requires an isolated DATABASE_PATH under C:\\andon\\work");
}
delete process.env.TURSO_DATABASE_URL; // always the isolated local file
const base = process.env.BASE_URL || "http://localhost:3101";
const realFetch = globalThis.fetch;
const health = await realFetch(`${base}/api/health`).then((r) => r.json());
assert.equal(path.resolve(health.db), path.resolve(process.env.DATABASE_PATH), "Test server must use the isolated test DB");

// Explicitly fake values, process-local only. No .env writes.
process.env.GOOGLE_CLIENT_ID = "test-client.invalid";
process.env.GOOGLE_CLIENT_SECRET = crypto.randomBytes(24).toString("hex");
process.env.GOOGLE_REDIRECT_URI = `${base}/api/auth/google/callback`;
const { db, nowIso } = await import("../src/lib/server/db.ts");
const auth = await import("../src/lib/server/auth.ts");
const google = await import("../src/lib/server/googleAuth.ts");
const identity = await import("../src/lib/server/googleIdentity.ts");
const routing = await import("../src/lib/server/routingService.ts");

const run = crypto.randomBytes(5).toString("hex");
const audit = { deviceId: "test-google-device", clientIp: "127.0.0.1", userAgent: "google-test" };
const profile = { employeeId: `G-${run}`, name: "[TEST] Google QC", department: "QC", phone: "010-1234-5678", kakaoId: "pilot-reference", companyEmail: "" };
const claims = { subject: `subject-${run}`, email: `google-${run}@example.test`, name: "Google Test" };

let passed = 0;
async function check(label: string, fn: () => unknown | Promise<unknown>) {
  await fn();
  passed++;
  console.log(`PASS ${passed}: ${label}`);
}
function cookieOf(res: Response, name: string) {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))!.split(";")[0];
}
function req(route: string, cookie = "", origin = base) {
  return new Request(base + route, {
    headers: { host: new URL(base).host, origin, cookie, "user-agent": audit.userAgent, "x-andon-device": audit.deviceId },
  });
}
const codeUrl = (state: string) => `/api/auth/google/callback?code=fixture-code&state=${state}`;
const count = async (sql: string, ...p: (string | number)[]) => Number((await db.get(sql, ...p))?.n);

// ---- fake Google (discovery, JWKS, token endpoint) inside this process
const key = await jose.generateKeyPair("RS256");
const jwk = await jose.exportJWK(key.publicKey);
jwk.kid = "fixture-key";
jwk.alg = "RS256";
let fixture: Record<string, unknown> = { sub: claims.subject, email: claims.email, email_verified: true, name: claims.name };
let expectedVerifier = "";
let pkceObserved = false;
let badSignature = false;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://accounts.google.com/") && url.includes(".well-known")) {
    return Response.json({
      issuer: "https://accounts.google.com",
      authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token",
      jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
  }
  if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
  if (url === "https://oauth2.googleapis.com/token") {
    const body = new URLSearchParams(String(init?.body));
    pkceObserved = body.get("code_verifier") === expectedVerifier;
    const signingKey = badSignature ? (await jose.generateKeyPair("RS256")).privateKey : key.privateKey;
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new jose.SignJWT({ iss: "https://accounts.google.com", aud: process.env.GOOGLE_CLIENT_ID, iat: now, exp: now + 300, ...fixture })
      .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
      .sign(signingKey);
    return Response.json({ access_token: "fixture-access-token", token_type: "Bearer", expires_in: 300, id_token: jwt });
  }
  return realFetch(input, init);
};

async function start(cookie = "", input: Record<string, unknown> = {}) {
  const r = await google.beginGoogle(req("/api/auth/google/start", cookie), input);
  const url = new URL((await r.json()).url);
  const flow = (await db.get("SELECT * FROM google_auth_flow WHERE state=?", url.searchParams.get("state")!))!;
  expectedVerifier = String(flow.verifier);
  fixture = { sub: claims.subject, email: claims.email, email_verified: true, name: claims.name, nonce: flow.nonce };
  return { response: r, url, cookie: cookieOf(r, "andon_google_flow"), state: url.searchParams.get("state")!, flow };
}

try {
  await check("unsafe redirects rejected", () => {
    for (const value of ["//evil.test", "/\\evil.test", "/\n/evil.test", "https://evil.test", "/api/auth/google/start", "/%2f%2fevil.test"]) {
      assert.equal(google.safeGoogleNext(value), "/respond");
    }
    assert.equal(google.safeGoogleNext("/respond/AND-20261001-001"), "/respond/AND-20261001-001");
  });
  await check("foreign and missing origin rejected", async () => {
    await assert.rejects(() => google.beginGoogle(req("/api/auth/google/start", "", "https://evil.test"), {}));
    await assert.rejects(() => google.beginGoogle(new Request(base + "/api/auth/google/start"), {}));
  });

  const flow = await start("", { next: "/respond" });
  await check("PKCE S256, state, nonce and fixed callback sent", async () => {
    assert.equal(flow.url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(flow.url.searchParams.get("code_challenge"), await oidc.calculatePKCECodeChallenge(expectedVerifier));
    assert.equal(flow.url.searchParams.get("nonce"), flow.flow.nonce);
    assert.equal(flow.url.searchParams.get("redirect_uri"), process.env.GOOGLE_REDIRECT_URI);
    assert.ok(flow.state);
  });
  await check("flow cookie is HttpOnly, scoped, short-lived and opaque", () => {
    const c = flow.response.headers.get("set-cookie")!;
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
    assert.match(c, /Max-Age=600/);
    assert.match(c, /Path=\/api\/auth\/google/);
    assert.ok(!c.includes(expectedVerifier));
  });
  await check("wrong state or absent browser cookie rejected", async () => {
    await assert.rejects(() => google.takeAuthorizationFlow(req(codeUrl("wrong"), flow.cookie)));
    await assert.rejects(() => google.takeAuthorizationFlow(req(codeUrl(flow.state))));
  });

  const callback = await google.completeGoogleCallback(req(codeUrl(flow.state), flow.cookie));
  await check("valid signed OIDC callback goes to onboarding, verifier sent", () => {
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), base + "/onboarding");
    assert.equal(pkceObserved, true);
    assert.ok(!callback.headers.getSetCookie().some((c) => c.startsWith("andon_session=")));
  });
  await check("authorization callback cannot be replayed", () =>
    assert.rejects(() => google.completeGoogleCallback(req(codeUrl(flow.state), flow.cookie))),
  );

  const onboardingCookie = cookieOf(callback, "andon_google_flow");
  await check("Google subject/token is not exposed to onboarding browser", async () => {
    const info = await google.onboardingInfo(req("/api/auth/google/onboarding", onboardingCookie));
    assert.equal(info.email, claims.email);
    assert.ok(!JSON.stringify(info).includes(claims.subject));
  });
  await check("onboarding rejects foreign origin", () =>
    assert.rejects(() => google.finishGoogleOnboarding(req("/api/auth/google/onboarding", onboardingCookie, "https://evil.test"), profile)),
  );

  const complete = await google.finishGoogleOnboarding(req("/api/auth/google/onboarding", onboardingCookie), {
    ...profile,
    ...{ role: "PLANT_MANAGER", active: false, provider_subject: "attacker" },
  });
  const session = cookieOf(complete, "andon_session");
  const user = (await auth.getSessionUser(req("/api/auth/me", session)))!;
  await check("new Google employee gets existing RESPONDER policy and server session", () => {
    assert.equal(user.role, "RESPONDER");
    assert.equal(user.departmentCode, "QC");
    assert.equal(user.active, true);
    assert.equal(user.email, null);
  });
  await check("request-body Google subject ignored", async () =>
    assert.equal((await db.get("SELECT subject FROM user_identity WHERE user_id=? AND provider='GOOGLE'", user.id))?.subject, claims.subject),
  );
  await check("onboarding replay rejected", () =>
    assert.rejects(() => google.finishGoogleOnboarding(req("/api/auth/google/onboarding", onboardingCookie), profile)),
  );
  await check("contact fields separate; no notification identity auto-created", async () => {
    assert.equal((await db.get("SELECT employee_id FROM app_user WHERE id=?", user.id))?.employee_id, profile.employeeId.toUpperCase());
    assert.equal(await count("SELECT COUNT(*) AS n FROM user_notification_channel WHERE user_id=?", user.id), 0);
  });
  await check("same subject with changed email resolves same employee", async () => {
    assert.equal((await identity.resolveGoogleIdentity({ ...claims, email: "changed@example.test" }))?.id, user.id);
    assert.equal((await db.get("SELECT provider_email FROM user_identity WHERE provider='GOOGLE' AND subject=?", claims.subject))?.provider_email, "changed@example.test");
  });
  await check("duplicate subject rejected and no extra employee left behind", async () => {
    const n = await count("SELECT COUNT(*) AS n FROM app_user");
    await assert.rejects(() => identity.registerGoogleEmployee(claims, { ...profile, employeeId: `OTHER-${run}` }));
    assert.equal(await count("SELECT COUNT(*) AS n FROM app_user"), n);
  });
  await check("database prevents same subject linked to two employees", () =>
    assert.rejects(() => db.run("INSERT INTO user_identity(user_id,provider,subject,created_at) VALUES (?,'GOOGLE',?,?)", user.id, claims.subject, nowIso()), /UNIQUE/),
  );
  await check("claiming existing employee ID without reauthentication rejected", () =>
    assert.rejects(() => identity.registerGoogleEmployee({ ...claims, subject: `other-${run}` }, profile), /이미 등록된 사번/),
  );
  await check("employee ID cannot change once assigned", () =>
    assert.rejects(() => db.run("UPDATE app_user SET employee_id=? WHERE id=?", "CHANGED", user.id), /permanent/),
  );
  await check("inactive Google employee cannot log in", async () => {
    await db.run("UPDATE app_user SET active=0 WHERE id=?", user.id);
    await assert.rejects(() => identity.resolveGoogleIdentity(claims), /비활성/);
    await db.run("UPDATE app_user SET active=1 WHERE id=?", user.id);
  });

  const loginFlow = await start(session);
  const loggedIn = await google.completeGoogleCallback(req(codeUrl(loginFlow.state), `${loginFlow.cookie}; ${session}`));
  const newSession = cookieOf(loggedIn, "andon_session");
  await check("Google login rotates session and revokes previous token", async () => {
    assert.notEqual(newSession, session);
    assert.equal(await auth.getSessionUser(req("/api/auth/me", session)), null);
    assert.equal((await auth.getSessionUser(req("/api/auth/me", newSession)))?.id, user.id);
  });
  await check("no provider tokens stored in flow or identity tables", async () => {
    const data =
      JSON.stringify(await db.all("SELECT * FROM google_auth_flow")) + JSON.stringify(await db.all("SELECT * FROM user_identity WHERE provider='GOOGLE'"));
    assert.ok(!data.includes("fixture-access-token"));
    assert.ok(!data.includes("eyJ"));
  });

  const password = `Pw-${crypto.randomBytes(12).toString("hex")}9`;
  const local = await auth.registerUser({ name: "[TEST] Local Google link", email: `local-${run}@andon.test`, department: "MT", password, passwordConfirm: password });
  const localCookie = `andon_session=${(await auth.createSession(local.id, audit)).token}`;
  await check("linking requires correct local password", () =>
    assert.rejects(() => google.beginGoogle(req("/api/auth/google/start", localCookie), { mode: "link", password: "wrong" })),
  );
  const linking = await start(localCookie, { mode: "link", password, next: "/me" });
  fixture = { ...fixture, sub: `linked-${run}`, email: local.email };
  const linkedCallback = await google.completeGoogleCallback(req(codeUrl(linking.state), `${linking.cookie}; ${localCookie}`));
  const linkPending = cookieOf(linkedCallback, "andon_google_flow");
  await check("link onboarding cannot move into another session", () =>
    assert.rejects(() => google.onboardingInfo(req("/api/auth/google/onboarding", `${linkPending}; ${newSession}`)), /다시 로그인/),
  );
  const linked = await google.finishGoogleOnboarding(req("/api/auth/google/onboarding", `${linkPending}; ${localCookie}`), {
    ...profile,
    employeeId: `LOCAL-${run}`,
    department: "QC",
  });
  await check("verified linking retains employee, department and local authentication", async () => {
    assert.equal((await auth.getSessionUser(req("/api/auth/me", cookieOf(linked, "andon_session"))))?.id, local.id);
    assert.equal((await auth.getPublicUser(local.id))?.departmentCode, "MT");
    assert.equal((await auth.authenticate(local.email, password, audit)).id, local.id);
    assert.equal(await count("SELECT COUNT(*) AS n FROM user_identity WHERE user_id=?", local.id), 2);
  });
  await check("one employee cannot acquire a second Google identity", () =>
    assert.rejects(() => identity.registerGoogleEmployee({ ...claims, subject: `second-${run}` }, { ...profile, employeeId: `LOCAL-${run}` }, local.id), /이미 Google/),
  );
  await check("Google email matching LOCAL email never auto-links", async () =>
    assert.equal(await identity.resolveGoogleIdentity({ subject: `unlinked-${run}`, email: local.email!, name: local.name }), null),
  );

  for (const [label, overrides] of [
    ["wrong nonce", { nonce: "wrong" }],
    ["wrong audience", { aud: "attacker" }],
    ["wrong issuer", { iss: "https://evil.test" }],
    ["expired token", { exp: 1 }],
    ["unverified email", { email_verified: false }],
  ] as const) {
    const bad = await start();
    fixture = { ...fixture, ...overrides };
    await check(`${label} rejected`, () => assert.rejects(() => google.completeGoogleCallback(req(codeUrl(bad.state), bad.cookie))));
  }
  const bad = await start();
  badSignature = true;
  await check("invalid ID token signature rejected", () => assert.rejects(() => google.completeGoogleCallback(req(codeUrl(bad.state), bad.cookie))));
  badSignature = false;
  const expiry = await start();
  await db.run("UPDATE google_auth_flow SET expires_at=? WHERE state=?", "2000-01-01", expiry.state);
  await check("expired authorization flow rejected", () => assert.rejects(() => google.takeAuthorizationFlow(req(codeUrl(expiry.state), expiry.cookie))));
  const hostFlow = await start();
  const wrongHost = new Request(base + codeUrl(hostFlow.state), { headers: { host: "evil.test", cookie: hostFlow.cookie } });
  await check("callback Host cannot change configured destination", () => assert.rejects(() => google.completeGoogleCallback(wrongHost)));

  // ---- existing HTTP transition endpoint: a Google session follows exactly the LOCAL routing policy
  globalThis.fetch = realFetch;
  const { Client, createAndon, transition, admin } = await import("./lib/testkit.ts");
  const client = new Client("google-session");
  client.cookie = newSession;
  const q = await createAndon("TGDI1", "WCC Final Inspection", "QUALITY", "[TEST] Google identity QC");
  const m = await createAndon("TGDI1", "WCC Final Inspection", "MAINTENANCE", "[TEST] Google identity MT");
  await check("anonymous operator CALL still works", () => {
    assert.equal(q.status, 201);
    assert.equal(m.status, 201);
  });
  await check("Google responder wrong department still rejected", async () => {
    const r = await transition(client, m.body.event.id, "ACKNOWLEDGE");
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "WRONG_DEPARTMENT");
  });
  await check("request-body identity spoofing rejected", async () => {
    const r = await transition(client, m.body.event.id, "ACKNOWLEDGE", undefined, { userId: local.id });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "RESPONDER_MISMATCH");
  });
  await db.run("UPDATE app_user SET role='OPERATOR' WHERE id=?", user.id);
  await check("Google session cannot bypass role authorization", async () => {
    const r = await transition(client, q.body.event.id, "ACKNOWLEDGE");
    assert.equal(r.body.code, "ROLE_NOT_ALLOWED");
  });
  await db.run("UPDATE app_user SET role='RESPONDER',active=0 WHERE id=?", user.id);
  await check("deactivation after Google login blocks responder actions", async () => {
    const r = await transition(client, q.body.event.id, "ACKNOWLEDGE");
    assert.equal(r.body.code, "INACTIVE_RESPONDER");
  });
  await db.run("UPDATE app_user SET active=1 WHERE id=?", user.id);
  await check("Google session ACK preserves server actor and device audit", async () => {
    const r = await transition(client, q.body.event.id, "ACKNOWLEDGE");
    assert.equal(r.status, 200);
    assert.equal(r.body.transitions.at(-1).userId, user.id);
    assert.equal(r.body.transitions.at(-1).deviceId, client.device);
  });
  await check("Google session ACTION and CLOSE preserve state machine", async () => {
    assert.equal((await transition(client, q.body.event.id, "ACTION", "[TEST] inspect")).status, 200);
    assert.equal((await transition(client, q.body.event.id, "CLOSE", "[TEST] complete")).body.event.status, "CLOSED");
  });
  const mtClient = new Client("google-mt");
  mtClient.cookie = cookieOf(linked, "andon_session");
  await transition(mtClient, m.body.event.id, "ACKNOWLEDGE");
  await transition(mtClient, m.body.event.id, "CLOSE", "[TEST] cleanup");

  // ---- review fixes (continuation after Astra)
  await check("typed KakaoTalk ID is NOT used as notification address", async () => {
    const me = (await routing.primaryRecipients("QC")).find((r) => r.id === user.id);
    assert.ok(me, "Google QC responder is a primary recipient");
    assert.equal((await db.get("SELECT kakao_id FROM app_user WHERE id=?", user.id))?.kakao_id, "pilot-reference");
    assert.equal(me!.kakaoRecipientId, null);
  });
  await check("only a verified + active KAKAO channel becomes the notification address", async () => {
    const rid = `unverified-${run}`;
    await db.run("INSERT INTO user_notification_channel(user_id,provider,recipient_id,verified,active,created_at) VALUES (?,'KAKAO',?,0,1,?)", user.id, rid, nowIso());
    assert.equal((await routing.primaryRecipients("QC")).find((r) => r.id === user.id)!.kakaoRecipientId, null, "unverified channel ignored");
    await db.run("UPDATE user_notification_channel SET verified=1 WHERE recipient_id=?", rid);
    assert.equal((await routing.primaryRecipients("QC")).find((r) => r.id === user.id)!.kakaoRecipientId, rid);
    await db.run("DELETE FROM user_notification_channel WHERE recipient_id=?", rid);
  });
  await check("status endpoint reveals only configured=true/false", async () => {
    const body = await (await realFetch(`${base}/api/auth/google/start`)).json();
    assert.deepEqual(Object.keys(body), ["configured"]);
    assert.equal(body.configured, false);
    assert.equal(google.googleConfigured(), true);
  });
  const reservedLocal = await auth.registerUser({ name: "[TEST] reserved emp", email: `reserved-${run}@andon.test`, department: "QC", password, passwordConfirm: password });
  await check("admin pre-assigned employee ID cannot be claimed by a Google newcomer", async () => {
    assert.ok(admin("user", "employee-id", reservedLocal.email!, `RES-${run}`).ok);
    await assert.rejects(() => identity.registerGoogleEmployee({ ...claims, subject: `squat-${run}` }, { ...profile, employeeId: `RES-${run}` }), /이미 등록된 사번/);
  });
  await check("admin employee-id cannot change an assigned employee ID", () =>
    assert.equal(admin("user", "employee-id", reservedLocal.email!, `OTHER2-${run}`).ok, false),
  );
  await check("admin unlink-google removes Google login and ends sessions", async () => {
    assert.ok(admin("user", "unlink-google", `emp:${profile.employeeId}`).ok);
    assert.equal(await identity.resolveGoogleIdentity(claims), null);
    assert.equal(await auth.getSessionUser(req("/api/auth/me", newSession)), null);
  });
  await check("missing Google config is explicit and does not expose secrets", async () => {
    const r = await realFetch(`${base}/api/auth/google/start`, { method: "POST", headers: { origin: base, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, "GOOGLE_NOT_CONFIGURED");
  });
  console.log(`GOOGLE CHECKS PASSED: ${passed}/${passed}. Real Google OAuth NOT tested.`);
} finally {
  globalThis.fetch = realFetch;
}
process.exit(0);
