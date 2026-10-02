# PROJECT.md — Digital ANDON (FORVIA Yeongcheon Plant)

> **Source of truth for AI-to-AI and human handover.** Update this file at the end of every
> meaningful milestone (sections 11–16 at minimum).
>
> Last updated: **2026-10-02** · **Shop-floor display v2 (plant map on `/dashboard`) — deployed 2026-10-02; 24 / 36 lines placed, 12 awaiting UAP position confirmation** · **A/B shift schedule (schema v7) — deployed 2026-10-02 (Turso + Vercel and local plant DB on v7); anchor NOT configured (awaiting plant confirmation)** · Milestone 1 — **done** · Milestone 2 — H1 + H2 done · 2A routing foundation — done · 2B registration & authentication — done · **Google authentication provider — done (offline-tested; real Google not yet configured)** · Vercel / Turso cloud demo · **Line master + UAP line ownership (schema v6) — done** · NEXT: Reaction Rules (Appendix A, not started — waits for Process / Trigger master and OBD answers)

---

## 1. Project objective

Build a working, demonstrable and stable **Digital ANDON prototype** for FORVIA Yeongcheon Plant,
ready **before 2026-10-22** (headquarters VIP visit).

Priority is that the complete ANDON workflow works end-to-end, not visual perfection.

**Golden Path**

```
Worker detects issue → creates ANDON → event stored → dashboard turns RED
→ responsible person notified (link) → opens event → ACKNOWLEDGE (YELLOW)
→ ACTION / corrective action recorded → CLOSE (GREEN)
→ full history stored → statistics updated
```

## 2. Business context

- Requested by the production organization (UAP), which has a real operational need.
- The existing ANDON environment once suffered a **~3 hour shutdown** during which production
  could not use it. The new system must therefore prioritise: simplicity, reliability, fast response,
  clear visibility, easy recovery, minimal interaction, traceability.
- **Not** an MES replacement (Phase 1).
- Will be developed with multiple AI assistants and later handed over to plant personnel.

## 3. Current architecture

```
 Operator tablet/phone ─┐                         ┌─ Live dashboard (big monitor, polls every 2 s)
 Responder phone ───────┼── HTTP (plant LAN) ──►  │
 Manager PC ────────────┘                         │
                         ┌────────────────────────┴──────────────────────────┐
                         │  ONE Next.js process (UI + REST API)              │
                         │   src/app/*            pages (client components)  │
                         │   src/app/api/*        route handlers             │
                         │   src/lib/server/andonService.ts  business logic  │
                         │   src/lib/server/notifications    provider layer  │
                         │   src/lib/server/db.ts  node:sqlite               │
                         └───────┬───────────────────────────┬───────────────┘
                                 │                           │
                       data/andon.db (SQLite, WAL)   data/uploads/ (photos)

 Windows scheduled task "Digital ANDON" (optional, at boot) ─► scripts/supervisor.ts
   └─ starts / restarts the Next.js process, health watchdog, logs → data/logs/
```

- **Supervisor** (`npm run serve`, `scripts/supervisor.ts`): runs `next start` directly (no npm
  wrapper), restarts it if it exits (back-off 1–30 s), restarts it if `/api/health` fails 3× in a row
  (after a 30 s start-up grace), rebuilds automatically if `.next/BUILD_ID` is missing, refuses to run
  twice, and on start stops stale servers **of this project only** (identified by command line
  containing the project folder or by `/api/health` reporting this project's DB file).
  PID files: `data/run/`. Logs: `data/logs/andon-YYYY-MM-DD.log` (30 days).
- **Single process, single DB file** on the plant server / this PC. No Redis, no message broker.
- **Second deployment: Vercel (cloud demo, https://forvia-yeongcheon-andon.vercel.app).** Same code; the server functions run in
  `iad1` and use **Turso** (hosted libSQL, `aws-us-east-1`, same region) instead of the SQLite file
  and a **private Vercel Blob** store instead of `data/uploads/`. Selected only by environment
  variables (`TURSO_DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`); see §9 "Vercel deployment".
  `src/lib/server/sql.ts` hides the two database drivers behind one async API.
- **Real-time = polling** (dashboard 2 s, responder list 3 s, detail 5 s). Simple and survives
  server restarts/network hiccups without reconnection logic. SSE can be added later if needed.
- **History is append-only**: `andon_transition` rows can't be updated or deleted (SQLite triggers).
- **Authentication (2B):** local accounts (e-mail + password, scrypt) and server-side sessions
  (`auth.ts`, HttpOnly cookie). Responder actions take the identity from the session only.
- **Responsibility & identity are server-side** (`routingService.ts`): routing Line + Process +
  Category → department at creation; every ACK / ACTION / CLOSE is validated against master data and
  recorded with user id, device id, IP and user agent. UI components only display server decisions.
- **Notifications** go through a `NotificationProvider` interface. Currently `mock` (console +
  `notification_log` table). A Kakao provider can be dropped in without touching ANDON logic.
- Server-side clock is authoritative: API responses include `serverTime`; clients correct
  elapsed-time display for clock skew.

## 4. Technology stack

| Item | Choice | Why |
|---|---|---|
| Runtime | **Node.js 24** (scripts need ≥ 22.18 for native TS; `engines` still says 22.13 — see §12) | built-in SQLite + native TypeScript execution for scripts |
| Framework | **Next.js 16.3** (App Router, Turbopack), React 19 | UI + API in one deployable; PWA-capable later |
| Language | TypeScript (strict) | |
| DB | **SQLite via built-in `node:sqlite`** (plant / local); **Turso** via `@libsql/client/web` on Vercel | zero native build, zero DB server, one-file backup; easy for plant IT. Turso only because Vercel has no persistent disk |
| Photos | local folder (plant / local); **private Vercel Blob** (`@vercel/blob`) on Vercel | photos are always served through `/api/photos/<name>`, never a public URL |
| Styling | Plain CSS (`src/app/globals.css`) | no extra tooling to learn |
| Scripts | `node scripts/*.ts` (Node native type stripping) | no `tsx`/esbuild dependency |

> ⚠ Next.js 16 differs from older versions (e.g. `params` is a Promise, `RouteContext` helper).
> Read `node_modules/next/dist/docs/` before changing framework-level code (see `AGENTS.md`).

## 5. Directory structure

```
C:\andon\  (git repository root)
├─ PROJECT.md              ← this file (handover source of truth)
├─ README.md               ← quick start
├─ RUNBOOK.md              ← one-page operations / recovery guide for plant personnel (KO/EN)
├─ .env.example            ← copy to .env
├─ scripts/
│  ├─ supervisor.ts        ← keeps the server running (npm run serve)
│  ├─ stop.ts / status.ts  ← npm run stop / npm run status
│  ├─ masterdata.ts        ← ADMIN: users (role / department / active / password reset), routing rules (npm run masterdata)
│  ├─ lib/runtime.ts       ← shared PID / port / health helpers for the three scripts above
│  ├─ windows/install-autostart.ps1, uninstall-autostart.ps1  ← scheduled task "Digital ANDON"
│  ├─ seed-demo.mts        ← demo data (npm run seed [-- --reset])
│  ├─ backup.ts            ← online DB backup (npm run backup)
│  ├─ test-golden-path.ts  ← end-to-end Golden Path API test, 26 checks (npm run test:golden)
│  ├─ test-reliability.ts  ← photo-failure tests, 6 checks (npm run test:reliability)
│  ├─ test-routing.ts      ← routing / identity / device audit: 10 unit + 29 API checks (npm run test:routing)
│  ├─ test-auth.ts         ← registration / login / session / authorization: 42 checks (npm run test:auth)
│  ├─ test-google.ts       ← Google OIDC with signed test tokens (no real Google): 48 checks (npm run test:google, isolated DB)
│  ├─ verify-google-migration.ts ← compares a v3 backup with its migrated v4 copy (all old rows/columns)
│  └─ lib/testkit.ts       ← test helpers: logged-in throw-away accounts, admin CLI calls
├─ data/                   ← runtime data, git-ignored (created automatically)
│  ├─ andon.db             ← SQLite database (+ -wal / -shm files)
│  ├─ uploads/             ← ANDON photos
│  ├─ backups/
│  ├─ logs/                ← supervisor + server logs, one file per day (KST)
│  └─ run/                 ← supervisor.pid, server.pid
└─ src/
   ├─ app/
   │  ├─ page.tsx                 home (links to 4 screens)
   │  ├─ operator/page.tsx        A. Operator ANDON call
   │  ├─ dashboard/page.tsx       B. Live dashboard (dark, large monitor)
   │  ├─ respond/page.tsx         C. Responder inbox (by department)
   │  ├─ respond/[id]/page.tsx    C. Event detail + ACK / ACTION / CLOSE (notification link target)
   │  ├─ history/page.tsx         D. History & analytics
   │  ├─ register/page.tsx        회원가입 (name, e-mail, department, password)
   │  ├─ login/page.tsx           로그인 (?next= returns to the page, e.g. an ANDON from a notification link)
   │  ├─ me/page.tsx              내 정보 + 로그아웃 + Google 계정 연결 (password re-check)
   │  ├─ onboarding/page.tsx      Google onboarding: employee ID, name, department, phone, KakaoTalk ID, company e-mail
   │  └─ api/
   │     ├─ andons/route.ts                 GET list (scope=board|active|all, mine=1 = my department via session), POST create (multipart, no login)
   │     ├─ andons/[id]/route.ts            GET detail + transitions + notifications + responsibility + eligibleResponders + viewer.canRespond
   │     ├─ andons/[id]/transition/route.ts POST {action, comment} — responder = session user (401 without); header x-andon-device
   │     ├─ stats/route.ts                  GET ?days=N
   │     ├─ meta/route.ts                   GET master data
   │     ├─ photos/[file]/route.ts          GET photo
   │     ├─ health/route.ts                 GET DB health (200 / 503)
   │     ├─ auth/register|login|logout|me   POST register / login / logout, GET current user
   │     └─ auth/google/start|callback|onboarding  Google OIDC: start (GET = configured?), callback, onboarding
   ├─ components/  TopBar (shows login / user), StatusBadge
   └─ lib/
      ├─ domain.ts         statuses, state machine rules, shared types (client + server)
      ├─ client.ts         browser helpers: api(), polling, formatting, local storage
      ├─ photoPrep.ts      on-device photo resize to ≤1600 px JPEG before upload
      ├─ routing.ts        PURE routing resolver + responder eligibility rules (unit-tested)
      └─ server/
         ├─ db.ts          connection, schema, pragmas, master-data bootstrap
         ├─ masterData.ts  initial lines/processes/categories/departments/users
         ├─ andonService.ts  create / transition / queries / stats  (ALL state changes here)
         ├─ routingService.ts  responsibility, department successors, eligible responders, recipients, responder validation
         ├─ auth.ts        registration, scrypt password hashing, login throttling, sessions, cookies, origin check
         ├─ googleAuth.ts  Google OIDC flow (openid-client): state / nonce / PKCE, callback, onboarding, session
         ├─ googleIdentity.ts  Google subject → employee; onboarding / linking rules (no takeover)
         ├─ errors.ts      AndonError, AuditInfo
         ├─ notifications/index.ts  NotificationProvider + Mock + notifyAndonCreated()
         ├─ photos.ts      photo save/read (type + size checks, path-traversal safe)
         └─ http.ts        error → HTTP response mapping
```

## 6. Database / data model

**Status model (state machine, `src/lib/domain.ts`)**

| Status | Signal | Korean | Allowed actions |
|---|---|---|---|
| `OPEN` | RED | 발생 | ACKNOWLEDGE |
| `ACKNOWLEDGED` | YELLOW | 접수 | ACTION, CLOSE |
| `IN_PROGRESS` | YELLOW | 조치중 | ACTION (repeatable), CLOSE |
| `CLOSED` | GREEN | 완료 | — |

- `ACTION` and `CLOSE` **require a comment** (action note / corrective action).
- Invalid transition → HTTP 409. Concurrent updates are guarded by `UPDATE … WHERE status = <read status>`.

**Tables** (`src/lib/server/db.ts`, schema **v7** — production Turso and local plant DB)

| Table | Purpose |
|---|---|
| `plant` | YC Yeongcheon (single plant for now) |
| `uap_area` | v6: UAP production areas AP-1, AP-2, AQ-1, AQ-2, AQ-3, BENDING, RESO (plant YC) |
| `line` | v6: the **36 real Yeongcheon UAP lines** (`uap_area_code` → uap_area) + the 3 prototype lines T-GDI 1, T-GDI 2, Muffler 1 (`uap_area_code` NULL) — `plant_code` → plant |
| `process` | processes per line; v6 `placeholder` = 1 marks the one "공정 미지정" stand-in of each real line (real process master pending) |
| `shift` | v6: A, B — `start_time` / `end_time` NULL = clock times not confirmed |
| `shift_schedule` | v7: per plant — `time_zone` Asia/Seoul, `day_start` 08:00, `night_start` 20:00, `rotation_weekday` MONDAY, **anchor** `anchor_week_monday` + `anchor_day_team` (both NULL = not configured; never seeded), `updated_at` / `updated_by` |
| `shift_schedule_audit` | v7: **append-only** (triggers) log of anchor changes — changed_at, user id + name, source WEB / CLI, old and new anchor, client IP, user agent |
| `line_assignment` | v6: line ownership — line → employee as `SUPERVISOR` (shift NULL) or `GAP_LEADER` (shift A / B), `effective_from` / `effective_to`, `active`, `source` WORKBOOK / ADMIN. One active row per (line, role, shift) (unique index). Ended rows stay as history |
| `department` | **ME, MT, UAP, QC, PCL** (active); `display_code` ("PC&L"), `sort_order`, `successor_code`. Pre-v3 codes QUALITY, PRODUCTION, MAINTENANCE, LOGISTICS, EHS stay as **inactive** rows with a successor |
| `category` | issue categories; `default_department` = routing when no rule matches |
| `role` | OPERATOR, RESPONDER, GAP_LEADER, SUPERVISOR, ENGINEER, PLANT_MANAGER; `can_respond`, `escalation_level` (prepared) |
| `app_user` | employee = id, **employee_id** (v4: unique, permanent once set — trigger), name (not unique), email (LOCAL login e-mail, unique; NULL = no local login), department_code → department, role → role, active, source, created_at; contact (v4): phone, kakao_id (typed KakaoTalk ID — reference only, NOT a notification address), company_email (optional); v6 `import_key` (unique; set for employees created by the workbook import → one record per person). Never delete — deactivate |
| `user_identity` | how a person logs in: provider LOCAL / GOOGLE (KAKAO later), subject (LOCAL: e-mail; GOOGLE: Google's stable `sub`), password_hash (LOCAL only), provider_email (v4, metadata only), last_login_at; unique (provider, subject); at most one GOOGLE identity per employee (v4) |
| `google_auth_flow` | v4: short-lived (10 min) server-side Google login state: phase AUTHORIZATION (state, nonce, PKCE verifier, next path, link target + session hash) or ONBOARDING (verified sub / e-mail / name). Browser holds only an opaque token (cookie scoped to /api/auth/google); rows are consumed once |
| `user_session` | server-side sessions: SHA-256 of the cookie token, user_id, expires_at, revoked_at, device / IP / user agent at login |
| `user_notification_channel` | **prepared, unused**: where a person receives messages (provider KAKAO / SMS / EMAIL, recipient_id, verified, active) — separate from login identity |
| `routing_rule` | category + line [+ process] → department override; `active`; unique per (category, line, process); trigger: process must belong to line |
| `andon_event` | **current state** + cached timestamps + `client_request_id` (UNIQUE, idempotency) + `department_code` and `routing_rule_id` (decided at creation, never re-routed) + `escalation_level` (prepared, always 0) |
| `andon_transition` | **append-only history** (UPDATE/DELETE blocked by triggers): action, from/to status, `user_name`, `user_id`, `user_department` + `user_role` (snapshot at the time of the action, v3), comment, created_at, `device_id`, `client_ip`, `user_agent` |
| `notification_log` | every notification attempt: provider, recipient, SENT/FAILED, message, error |
| `escalation_policy`, `escalation_step` | **prepared, inactive** escalation model (see below) |

- ANDON ID format: `AND-YYYYMMDD-NNN` (KST date, daily sequence).
- All timestamps stored as UTC ISO-8601 strings; displayed in Asia/Seoul.
- **Migrations:** applied schema version (now **5**; v5 = `login_throttle`) is `PRAGMA user_version`
  in a SQLite file and the one row of table `schema_meta` on Turso (Turso rejects writes to
  `user_version`). On a file DB `db.ts` runs pending migrations at start-up, each in its own
  transaction, after writing `data/backups/andon-pre-migration-v<from>-to-v<to>-<time>.db`. A remote
  (Turso) DB is migrated **only** by `npm run db:migrate`; the deployed app refuses a remote DB whose
  version differs. A DB newer than the app is refused. Never edit a released migration; add a new one.
- Master data is seeded at start-up only if missing (`INSERT … WHERE NOT EXISTS` / `INSERT OR IGNORE`)
  → DB edits (e.g. via `npm run masterdata`) are never overwritten. A *deleted* seeded row would be
  re-created on the next start — deactivate instead of deleting.
- Pre-v2 history rows have `user_id`, `device_id`, `client_ip`, `user_agent` = NULL (history is
  never rewritten).

**Routing model** (`src/lib/routing.ts` pure resolver, `src/lib/server/routingService.ts` DB access)

```
Line + Process + Category ─► most specific ACTIVE routing_rule
                               1. category + line + process   (LINE_PROCESS_CATEGORY)
                               2. category + line             (LINE_CATEGORY)
                               3. category.default_department (CATEGORY_DEFAULT)
                          ─► responsible department (stored on the event + routing_rule_id)
                          ─► eligible responders = active users of that department whose role can_respond
                          ─► initial notification = active RESPONDER-role users of that department
```

Deterministic: at most one rule per (category, line, process) (unique index); the result never depends
on rule order. Seeded override: `기타` at T-GDI 1 / Packing → PCL.

**Department model (v3) — Category ≠ Department.** A *category* says WHAT happened (QUALITY,
MAINTENANCE, PRODUCTION, MATERIAL, SAFETY, OTHER). A *department* says WHO is responsible. Routing maps
one to the other; departments are never used as categories.

| Code | Shown as | Name | Category defaults routed here |
|---|---|---|---|
| ME | ME · 생산기술 | Production / Manufacturing Engineering | none yet (add routing rules when the plant defines them) |
| MT | MT · 보전 | Maintenance | MAINTENANCE |
| UAP | UAP · 생산 | Production | PRODUCTION, OTHER, SAFETY (*) |
| QC | QC · 품질 | Quality | QUALITY |
| PCL | PC&L · 물류 | Production Control & Logistics | MATERIAL (+ rule: 기타 at T-GDI 1 / Packing) |

(*) SAFETY → UAP and old EHS → UAP are prototype decisions (there is no safety department among the
five) — **to be confirmed by the plant**; change with `npm run masterdata -- category default SAFETY <DEPT>`.

Events created before v3 keep their original code (e.g. `QUALITY`); the inactive department row points
to its successor (QUALITY → QC, MAINTENANCE → MT, PRODUCTION → UAP, LOGISTICS → PCL, EHS → UAP).
Eligibility, the inbox and notifications follow the successor, so those events stay actionable by the
new department without rewriting history. Display: "QUALITY · 품질" (original code is visible).

**Authentication model (2B, LOCAL only)**
- **Register** (`/register`, `POST /api/auth/register`): name, e-mail, department (one of the five),
  password + confirmation. Server-side validation: e-mail normalized (trim + lowercase) and unique
  (unique index — also safe against simultaneous registrations); password 8–128 chars with a letter
  and a digit; department must be active. **Role is always RESPONDER, active = true** — a role sent by
  the client is ignored. GAP_LEADER / SUPERVISOR / ENGINEER / PLANT_MANAGER / OPERATOR are assigned by
  an administrator only (`npm run masterdata -- user role <user> <ROLE>`). Registration logs the user in.
- **Passwords**: Node `crypto.scrypt` (N=2^15, r=8, p=3, 16-byte salt, 64-byte key; parameters stored
  with the hash), compared with `timingSafeEqual`. Never stored or logged in plaintext, never returned.
- **Login** (`/login`, `POST /api/auth/login`): same error for unknown e-mail and wrong password (and a
  dummy hash for unknown e-mails so timing does not reveal accounts); inactive accounts get 403;
  5 failures per e-mail + IP within 15 min → 429 (in memory). Every login creates a NEW random 256-bit
  token (no session fixation) and revokes the session cookie sent with the request.
- **Session**: cookie `andon_session` — HttpOnly, SameSite=Lax (so opening a notification link keeps
  the user logged in), Path=/, Secure on HTTPS (`COOKIE_SECURE`). Only the SHA-256 of the token is
  stored (`user_session`). Lifetime `SESSION_TTL_HOURS` (default 7 days). The user's department, role
  and active flag are read from the DB on **every** request, so deactivation or a role change applies
  immediately. Logout revokes the session server-side. State-changing auth requests reject a foreign
  `Origin` header (403). Nothing auth-related is stored in localStorage.
- **Google login (OIDC, additional provider)** — `googleAuth.ts` / `googleIdentity.ts`, library
  `openid-client` 6 (OpenID-certified). Flow: `POST /api/auth/google/start` (exact Origin check) →
  Google (authorization code + PKCE S256, `state`, `nonce`, scope `openid email profile`) →
  `GET /api/auth/google/callback`: the flow is looked up by the opaque flow cookie AND the `state` and
  deleted in the same statement (one-time); the code is exchanged server-side; the ID token is verified
  (signature against Google's JWKS, issuer `https://accounts.google.com`, audience = client id, expiry,
  nonce) and `email_verified` must be true. The employee is resolved **only by Google `sub`** — the
  Google e-mail is metadata and never identifies or links an employee.
  - **Known `sub`** → active employee → new ANDON session (previous session revoked) → redirect to an
    allow-listed page (`/respond[/AND-…]`, `/me`, `/dashboard`, `/history`, `/operator`).
  - **Unknown `sub`** → onboarding (`/onboarding`): employee ID, name, department, phone, KakaoTalk
    ID, optional company e-mail → new employee, role RESPONDER, active (same policy as local
    registration). The Google identity stays on the server; nothing from the browser can change it.
    An employee ID that already belongs to someone cannot be claimed (409).
  - **Existing local employee → link Google** (from `/me`): requires an active local session AND
    re-entering the local password; the flow is bound to that exact session, which must still be the
    same at callback and onboarding. Linking keeps name, department, role, local login and history; it
    sets the employee ID (if not set yet) and contact fields. One Google account per employee and one
    employee per Google account (unique indexes).
  - Logs contain only error codes — never authorization codes, tokens, claims or the client secret.
    Tokens are not stored. The callback always redirects (303) so the code leaves the address bar;
    `Referrer-Policy: no-referrer`.
  - Config: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (exactly
    `<origin>/api/auth/google/callback`; HTTPS, or http://localhost for development). Without them the
    Google button is hidden and the API answers 503 `GOOGLE_NOT_CONFIGURED`; local login is unaffected.
  - Routing and eligibility only use `app_user` (department, role, active), never the provider. A Kakao
    login would be one more `user_identity` provider.
- **Notification identity is separate**: `user_notification_channel` holds the KakaoTalk recipient id.
  Notification addresses come **only** from a verified + active channel row (`primaryRecipients`);
  the typed `app_user.kakao_id` and a Google e-mail are never used as recipients.

**Responder identity** (`validateResponder`): ACK / ACTION / CLOSE over HTTP require a session
(401 `AUTH_REQUIRED`); the responder is **always the session user**. A body that names a different
user is rejected (400 `RESPONDER_MISMATCH`). The user must be active (403 `INACTIVE_RESPONDER`), have
a role with `can_respond` (403 `ROLE_NOT_ALLOWED`, e.g. OPERATOR) and belong to the event's current
responsible department (403 `WRONG_DEPARTMENT`). Rejected attempts change nothing. Escalation roles of
the same department may also respond. A newly registered RESPONDER is eligible immediately — no
routing change needed. (Name-based identity remains only for server-internal callers: the demo seeder.)

**Device audit**: each browser creates a random device id once (`localStorage` `andon.device.id`)
and sends it as header `x-andon-device` on every request. The server stores it with the client IP
(as reported via `x-forwarded-for` — not authenticated) and the user agent on every history row
(CREATE, ACKNOWLEDGE, ACTION, CLOSE), plus the actor's user id, name, department and role at that time.
The responder screen shows them in the history timeline.

**Line master and line ownership (v6)** — source: plant workbook "모바일 안돈시스템(261001) QC.xlsx"
(sheets 개인정보 and UAP(Line 구분); the workbook stays outside the repository — it contains personal data).

```
Plant YC ─► UAP area (7) ─► Line (36 real) ─► line_assignment
                                               ├─ SUPERVISOR            (no shift)
                                               ├─ GAP_LEADER  shift A
                                               └─ GAP_LEADER  shift B ─► app_user (employee, one per person)
```

- **Lines** (code → name as in the workbook): AP-1 Main #1, Main #2, FRT, NX4 CTR, NX4 MAIN, NX4 CTR #2 ·
  AP-2 CTR #1, CTR #2, Main #3, JX ASSY, JX SUB, JX LAMBDA FRT · AQ-1 NU-I #1, NU-I #1 EXMANI, GPF,
  NU-I #2, NU-I #2 EXMANI · AQ-2 KAPPA 1.6, TURBO #2 EU7, EXMANI #1, EXMANI #2, GAMMA #2, TURBO#1 ·
  AQ-3 GAMMA #3, UCC, KAPPA UCC, R-ENG, STUFFING · BENDING HE BENDING, PIPE CUTTING, CE BENDING ·
  RESO LOCKSEAM, QX RESO, CTR RESO, SX2 RESO, JX/NX4 RESO. Defined in `masterData.ts` (no personal data).
- **Ownership is line-specific.** Each line has one supervisor and one GAP leader per shift. A supervisor
  owns all lines of an area; within an area, sub-groups of lines have different A / B GAP leaders (e.g.
  AQ-3: same A leader for all five lines, different B leaders for GAMMA #3 / UCC / KAPPA UCC and R-ENG /
  STUFFING). Imported: 7 supervisors + 28 GAP leaders = 35 employees, 108 assignments (36 × 3).
- **A / B = shift assignment**, modelled in `line_assignment.shift_code` — never part of a name.
  `resolveLineOwnership` (`src/lib/server/lineAssignments.ts`) returns the supervisor and both shifts' GAP
  leaders; `currentGapLeader` only when the caller passes the team explicitly. Which team is on duty comes
  from the A/B shift schedule (v7, below) — and only once its anchor is configured.
- **In force** = `active = 1`, `effective_from <= now < effective_to` (or open-ended) and the employee
  is active. Inactive, ended, future or deactivated-employee assignments are ignored.
- **Employees** created by the import: department UAP, role SUPERVISOR / GAP_LEADER, **no login and no
  contact data** (phone, Google ID, Kakao ID, employee ID, e-mail are never read from the workbook).
  Matching key `app_user.import_key` → repeating the import or a person covering several lines never
  duplicates the employee. To let such a person log in, an administrator runs
  `npm run masterdata -- user set-login <user> <e-mail>` (registering again would create a second record).
- **Workbook cross-check** (`scripts/lib/uap-workbook.ts`): the UAP sheet is line-specific and decides
  each line's leaders; supervisors, their lines and areas must agree with 개인정보 (otherwise the import
  is refused). Known difference, reported as a warning: for **BENDING shift B**, 개인정보 lists both B
  leaders for all three lines, while UAP(Line 구분) assigns one to HE BENDING + PIPE CUTTING and the other
  to CE BENDING. The UAP sheet was used — **to be confirmed by the plant** (OBD list below).
- **Ownership ≠ responsible department.** Supervisor / GAP leader is the *actor* who owns the line. Which
  department must act on an ANDON is still decided by category + routing rules (unchanged). Future
  hierarchy (Appendix A): Plant → Line → Process → Trigger → Reaction Rule → Actor role → Responsible
  department → Eligible responder; `line_assignment` provides "Actor role → person" for a line.
- **Process master is missing** → each real line has one process "공정 미지정" (`process.placeholder = 1`)
  because `andon_event.process_id` is required. The operator screen selects it automatically and says
  the process master is in preparation. Replace it when the plant delivers the Line → Process master
  (add real processes, deactivate the placeholder; existing events keep it).
- **Who sees what:** `/api/meta` (public, operator) returns areas, lines and processes only — no people.
  `/admin/lines` + `GET /api/admin/lines` show line → supervisor / GAP leaders (names only) and require
  a login with role GAP_LEADER, SUPERVISOR, ENGINEER or PLANT_MANAGER (assigned by an administrator;
  self-registered accounts are RESPONDER and get 403).
- **Prototype lines** T-GDI 1, T-GDI 2, Muffler 1: hidden from the operator line choice with `line.active = 0`
  (`npm run masterdata -- line deactivate <LINE>`), never deleted. `/api/meta` lists only active lines; events,
  history, dashboard and statistics of these lines are unchanged. Done in the cloud; local DB still active.

**Shop-floor display v2 — plant map ANDON (`/dashboard`, 2026-10-02)** — answers "WHERE is the abnormal
condition right now?" from several meters away. No schema change.

- **Source:** `layout.pptx` page 2 "PLANT LAYOUT" (Jan 2026). Shape coordinates were read from the slide XML
  (no background image) and turned into `src/config/plantLayout.ts`: station cells in a 100 × 100 map
  frame (production rows get more height than warehouses), zone backgrounds (AQ ASSEMBLY, AP ASSEMBLY,
  forming / bending / stuffing, RESO) and orientation landmarks (finished goods / BOP / catalyst
  warehouses, QC lab, maintenance). Page 1 evacuation content is not used.
- **Mapping (DB line → station):** 24 / 36 real lines placed — 22 by exact name, HE / CE BENDING by the
  page-1 name of the same cell (page 2 calls them AQ / AP BENDING). **12 lines are explicitly unmapped**
  (`UNMAPPED_LINES`, with candidate station and reason): NX4 CTR #2, JX ASSY, JX LAMBDA FRT, PIPE CUTTING,
  LOCKSEAM, QX RESO, SX2 RESO, JX/NX4 RESO (names differ from the drawing), TURBO #2 EU7, TURBO#1, R-ENG,
  STUFFING (no unambiguous station). They are shown in the "배치 위치 확인 필요 · Position to confirm" tray
  next to the map — never hidden. To confirm one: move its code to the station's `lineCode`
  (`match`), remove it from `UNMAPPED_LINES`, run `npm run test:display`.
  Stations without a DB line (R-DPF, GAMMA2 T-GDI, KAPPA EU7, AUTO STUFFING #1 / #2, candidate cells)
  are drawn as faint dashed outlines for orientation only.
- **Plant-confirmed station descriptions (2026-10-02):** GPF = one line for **EURO7 GPF and GAMMA T-GDI 3차**
  (shown under the line name); the KAPPA EU7 station = one line for **KAPPA EU7 and GAMMA TURBO 1차**. Which
  DB line belongs to the KAPPA EU7 station (TURBO #2 EU7 or TURBO#1) is **not confirmed yet** — still in the tray.
- **Behaviour:** lines keep their physical position. Normal = dark tile with a muted green bar (recedes);
  OPEN = red (one subtle pulse, off with reduced motion); ACKNOWLEDGED / IN_PROGRESS = amber; CLOSED =
  normal again. Several active events on one line → most urgent state + count badge. Abnormal tile:
  line, category, description, elapsed time, state; it links to `/respond/<id>`. Top bar: OPEN /
  IN ACTION / NORMAL line counts, shift (`SHIFT: UNRESOLVED` until the anchor exists — never A/B guessed),
  clock, LIVE / "서버 연결 끊김". Active ANDON panel: OPEN first, then longest elapsed. A line with an
  active event that is not on the map (e.g. a hidden prototype line with an old event) appears in the tray.
- **Data / privacy:** same 2-s polling of `/api/andons?scope=board`, which now also returns
  `shift` = team + DAY/NIGHT or UNRESOLVED (never the anchor). The map shows no people. (The existing
  event objects still contain acknowledgedBy / closedBy names; the display does not render them.)
- **Screens:** 1920 × 1080 fits without scrolling (verified); ≤ 1500 px compact header and side panel;
  ≤ 1100 px the active list comes first and the map scrolls horizontally. Pure logic: `src/lib/plantMap.ts`.
  The previous card dashboard is at `/dashboard/list`.

**A/B shift schedule (v7)** — confirmed plant rule for Yeongcheon UAP (2026-10-02):

- 12-hour shifts; shift changes at **08:00** (DAY starts, inclusive) and **20:00** (NIGHT starts, inclusive);
  time zone **Asia/Seoul** (no DST). Shift decisions never use the server / Vercel clock zone.
- Teams A and B alternate DAY / NIGHT **weekly**. The weekly swap happens at the **Monday 08:00** DAY shift,
  not at Monday 00:00: a shift belongs to the operational date / week of its **start**, so Monday
  00:00–07:59:59 is still the previous week's Sunday NIGHT shift.
- Which team has DAY in a given week needs ONE fact from the plant: the **anchor** (a Monday + the team on
  DAY that week). From it every past / future week is calculated (even week distance = same DAY team).
  **The anchor is NOT configured and NOT assumed.** Until it is set, the resolver returns
  `SHIFT_SCHEDULE_NOT_ANCHORED` and never picks A or B; automatic A/B determination is not authoritative.
- Pure resolver `src/lib/shiftSchedule.ts` → operationalDate, shiftType DAY / NIGHT, shiftStart / shiftEnd
  (ISO with +09:00), rotationWeekStart, rotationWeek, dayTeam / nightTeam, activeTeam, nextChangeAt,
  nextRotationAt. Server side: `src/lib/server/shiftService.ts`.
- **Anchor administration:** `/admin/shifts` + `GET / PUT /api/admin/shift-schedule` — view: GAP_LEADER,
  SUPERVISOR, ENGINEER, PLANT_MANAGER; change: SUPERVISOR, PLANT_MANAGER (login, same-origin, server
  validation: a Monday + A / B). CLI: `npm run masterdata -- shift show | shift anchor <YYYY-MM-DD> <A|B>`.
  Every change is written to `shift_schedule_audit` (who, when, old, new). Not exposed by any public API.
- **ANDON snapshot:** each NEW event stores `andon_event.shift_status` (RESOLVED / UNRESOLVED),
  `shift_unresolved_reason` (e.g. SHIFT_SCHEDULE_NOT_ANCHORED), `shift_team`, `shift_type`,
  `shift_operational_date`, `shift_start_at`, `gap_leader_assignment_id` (the line's GAP leader of the
  active team) and `supervisor_assignment_id` (independent of A/B), taken at creation. Events created
  before v7 keep NULL (no back-fill); changing the anchor never rewrites events. A shift-resolution problem
  never blocks an ANDON call — the event is created with UNRESOLVED. Snapshot fields are not in public
  event APIs yet.
- **Separate from routing:** Line → active team → that line's GAP leader → supervisor is actor ownership.
  The responsible department (category / routing rules) is unchanged. Nothing is sent (no Kakao).

**Escalation model — prepared, NOT active.** Intended flow:
`OPEN → RESPONDER notified → no ACK after threshold → GAP_LEADER → SUPERVISOR / ENGINEER → PLANT_MANAGER`.
`escalation_policy` (code, optional department/category scope, `active` = 0) and `escalation_step`
(policy, `step_no`, `target_role`, `after_minutes` = **NULL / not configured**, `active` = 0) hold
the configuration; `role.escalation_level` and `andon_event.escalation_level` exist for later. No code
reads these tables yet and no thresholds are hard-coded. Implementing it later needs: a periodic job in
the server process, a per-event escalation log, recipient lookup by (department, role), and
notification via the existing provider.

**Future AI/rule monitoring readiness**: every state change is an immutable, timestamped row in
`andon_transition`, and `andon_event` has indexed `status` / `created_at`. Rules such as
"not acknowledged within 5 min" or "same defect 3×" are simple queries over these tables;
alerts can go through the same `NotificationProvider`.

## 7. Environment variables

See `.env.example`. Copy to `.env`. No secrets in source code.

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_TTL_HOURS` | `168` | login session lifetime (hours) |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client id (Web application). Empty = Google login hidden |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret — **only in `.env`**, never in git / chat / logs |
| `GOOGLE_REDIRECT_URI` | — | exactly `<origin>/api/auth/google/callback` (must match Google Cloud and the address users open) |
| `COOKIE_SECURE` | `auto` | `auto` = Secure flag only on HTTPS; `true` / `false` to force |
| `PORT` | `3000` | server port used by `npm run serve` (this dev PC uses `3100`: port 3000 is taken by another app) |
| `HOST` | (all interfaces) | optional bind address for `npm run serve` |
| `DATABASE_PATH` | `./data/andon.db` | SQLite file |
| `UPLOAD_DIR` | `./data/uploads` | photo folder |
| `APP_BASE_URL` | `http://localhost:3000` | base for links in notifications — **set to the LAN address** |
| `NOTIFICATION_PROVIDER` | `mock` | `mock` only for now; `kakao` planned |
| `KAKAO_*` | — | placeholders for the future Kakao provider (keep only in `.env`) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | — | **Vercel only** (set by the Turso integration). If set, the app uses Turso instead of `DATABASE_PATH`. **Never put them in `.env` / `.env.local` of the plant server** |
| `BLOB_READ_WRITE_TOKEN` | — | **Vercel only** (set by the Blob store connection). If set, photos go to private Vercel Blob instead of `UPLOAD_DIR` |

## 8. How to install

```bash
# Node.js 24 LTS required (check: node --version)
cd C:\andon
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm run seed -- --reset     # optional: realistic demo data
```

## 9. How to run

```bash
npm run serve     # production mode under the supervisor (use this for demos / plant)
npm run status    # supervisor + server state, health, last log lines
npm run stop      # stop supervisor and server (always use this, not Task Manager)
npm run dev       # development mode with hot reload
```

- Port comes from `PORT` in `.env` (default 3000). Phones/tablets use `http://<server-LAN-IP>:<PORT>`.
- `npm run serve` builds automatically if no production build exists.
- **Auto-start at boot:** `scripts/windows/install-autostart.ps1 -AtStartup` (admin PowerShell) registers
  the scheduled task "Digital ANDON"; Windows restarts the supervisor every minute if it dies.
  `-DryRun` shows what would be registered. Remove with `uninstall-autostart.ps1`.
- **Master data:** `npm run masterdata -- list` (and user / route / category commands; see RUNBOOK.md §7).
- **Recovery / operations:** see **RUNBOOK.md**. All state is in `data/`; logs in `data/logs/`.
- `npm run start` (plain `next start`, no supervisor) still works for quick local checks; don't
  use it for the plant — stopping its npm wrapper on Windows can leave the server process running.
- **Backup:** `npm run backup` (safe while running) → `data/backups/`.
- **Reset demo data:** stop the server, `npm run seed -- --reset` (previous DB is backed up first).

### Vercel deployment (cloud demo)

| Item | Value |
|---|---|
| URL | https://forvia-yeongcheon-andon.vercel.app (Vercel project `forvia-yeongcheon-andon`, team `sugoii77-rgbs-projects`, Hobby plan) |
| Deploys | automatically on every push to `main` of GitHub `sugoii77-rgb/forvia-yeongcheon-andon` |
| Functions | region `iad1` (`vercel.json`), Node 24 (`engines`) |
| Database | Turso `andon-db` (Vercel Marketplace integration, `aws-us-east-1`); env `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` |
| Photos | private Blob store `andon-photos` (`icn1`); env `BLOB_READ_WRITE_TOKEN` |
| Other env (production + preview) | `COOKIE_SECURE=true`, `NOTIFICATION_PROVIDER=mock`, `SESSION_TTL_HOURS=168`, `APP_BASE_URL=https://forvia-yeongcheon-andon.vercel.app` |

- **Schema changes:** before pushing code with a new migration, migrate Turso first:
  `vercel env run -e production -- npm run db:migrate` (credentials stay in the process environment;
  nothing is written to disk). Then push. The deployed app refuses a DB with a different version.
- **Demo data:** `vercel env run -e production -- npm run seed` adds demo events (`--reset` is refused
  for Turso). Preview deployments use the **same** Turso DB and Blob store as production.
- **Never** run `vercel env pull` into `C:\andon` — a `.env.local` with `TURSO_*` would switch the
  plant server to the cloud DB. Use `vercel env run` instead.
- `/api/health` shows `"backend": "remote"` on Vercel and `"file"` on the plant server.

## 10. How to test

| Command | What it checks |
|---|---|
| `npm run typecheck` | Next typegen + `tsc --noEmit` |
| `npm run lint` | ESLint (Next config) on `src/` and `scripts/` |
| `npm run build` | production build |
| `npm run test:golden` | **end-to-end Golden Path against a running server** (set `BASE_URL`, default `http://localhost:3000`). 26 checks: create, idempotent duplicate, validation, board RED, photo, path traversal, notification log, illegal transitions (409), ACK/ACTION/CLOSE, full history, stats delta. Creates one `[TEST]` event (left CLOSED). |
| `npm run test:reliability` | 6 checks: ANDON is still created (RED, no photo, warning returned) when the photo is GIF / has no MIME type / is 12 MB; valid photo still attached; no photo OK. Creates 5 `[TEST]` events and closes them. |

| `npm run test:routing` | 10 unit checks of the routing resolver / eligibility (no server) + 29 API checks: routing of every category, process-level override (→ PCL, shown "PC&L · 물류"), eligible-responder list, no session → 401, body naming another user (id or name) → rejected, wrong department → 403 without side effects, session responder ACK with user id / name / department / role / device / IP / user agent in history, GAP_LEADER (set by admin) may act, invalid device id dropped, server-side inbox (`mine=1`, incl. pre-v3 QUALITY events), pre-v3 event handled by successor department, full ordered history. |
| `npm run test:auth` | 42 checks — registration (valid, role in body ignored, no secrets in responses, cookie flags, duplicate e-mail incl. case variant, 5 simultaneous registrations → 1 account, invalid e-mail / department / inactive pre-v3 department / short password / no digit / mismatch / empty name), login (valid, wrong password, unknown user with identical message, session fixation, logout + cookie replay, forged token, foreign Origin → 403, inactive → 403, 6th failure → 429), authorization & routing (new QC / MT / PC&L responders automatically eligible, QC cannot ACK MT, body spoofing rejected, no session → 401, audit fields, deactivated after login → 403, OPERATOR role → 403, admin department change moves eligibility). |

| `npm run test:display` | Plant-map display (33 checks with `--http`): every real line on exactly one station or explicitly unmapped (24 + 12), codes exist, demo lines not placed, no duplicate / overlapping / out-of-frame boxes; OPEN → red, ACK / IN_PROGRESS → amber, CLOSED → normal, several events on one line (count, lead), active-list order, elapsed timer with fixed timestamps, unresolved shift never shows A/B, demo line only while it has an active event; `--http`: board shift UNRESOLVED without team, no personnel / contact / auth / anchor fields in board + meta, demo-line history served, `/dashboard` and `/dashboard/list` render. |
| `npm run test:shifts` | A/B shift schedule (54 checks with `--http`), fixed timestamps only (the anchor in the tests is a TEST value). **A** pure resolver: Mon 07:59:59 (previous week's Sunday NIGHT), Mon 08:00:00, 19:59:59, 20:00:00, Tuesday, Sunday day / night, following Mon 07:59:59 / 08:00:00 (swap), ±2 / 52 weeks, UTC input, DST dates and process TZ (New York / Berlin / UTC / Auckland) without effect, missing anchor → SHIFT_SCHEDULE_NOT_ANCHORED, invalid anchors / rule / timestamp. **B** isolated DB: rule seeded without anchor; ANDON creation with no anchor / broken rule / missing schedule still succeeds (UNRESOLVED, routing normal, supervisor recorded); anchor validation, audit (who / when / old / new, append-only), anchor change does not rewrite events; snapshot team A / B → that line's A / B GAP leader, Monday 07:59:59 and next-week swap, supervisor independent of A/B, line-specific, no invented references, no shift fields in public objects. **C** `--http`: 401 / 403 (RESPONDER) / GAP_LEADER view-only, PUT 403 for GAP_LEADER, 400 invalid, foreign Origin 403, SUPERVISOR 200 + audited, `/api/meta` without schedule. **D** Turso-compatible v6 → v7 with an existing event (unchanged, snapshot NULL). |
| `npm run test:lines` | Line master + ownership (70 checks with `--http --workbook`). **A** isolated DB under `work/lines-test/` with a synthetic workbook (fake names, plant layout): 36 lines exactly once, areas, placeholder processes, shifts without times, ANDON on a real line, parser + sub-group inheritance, BENDING-type warnings, contradiction rejected, import, every line → supervisor / A / B, explicit shift, no duplicate employees, repeated import = no change, changed person → old ended + new, inactive / ended / future / deactivated-employee ignored, constraints (unique, shift rules, FKs), contact columns never read or stored, public master data without people / contact fields, events / history / notifications / routing / users unchanged. **B** Turso-compatible migration: remote driver path on local libSQL that rejects `PRAGMA user_version =` like Turso, v5 with data → v6, rows unchanged. **C** `--http` (`BASE_URL`, `DATABASE_PATH` = server DB): `/api/meta` field names, 401 / 403 / 200 on `/api/admin/lines`, no contact fields, no assigned person in `/api/meta`. **D** `--workbook <file>`: real workbook into a fresh isolated DB, every line = workbook supervisor / A / B; prints counts only. |
| `npm run db:verify-remote-migration` | Turso DRY RUN: pending migrations + seed inside one transaction that is always rolled back; checks old rows / columns (checksums), FKs, append-only, then that nothing changed. Run with `vercel env run -e production --`. |
| `npm run test:google` | 48 checks with a local fake Google (signed test tokens, fake JWKS) — **real Google is not contacted**. Needs an isolated test server and `DATABASE_PATH` under `work/` (see below). Covers redirect allow-list, Origin checks, PKCE / state / nonce, flow cookie flags, wrong state / missing cookie / replay / expiry, onboarding (no subject exposed, replay, role in body ignored), changed Google e-mail → same employee, duplicate subject, one Google per employee, employee-ID claim protection, immutable employee ID, inactive employee, session rotation, no tokens stored, linking with password re-check bound to the session, Google e-mail never auto-links, wrong nonce / audience / issuer / expired / unverified e-mail / bad signature, Host header, real API: operator call, wrong department, body spoofing, role, deactivation, ACK / ACTION / CLOSE with audit; typed KakaoTalk ID is not a notification address; configured-status endpoint; admin employee-id / unlink-google. |

> **Isolated Google test** (keeps the live DB untouched): copy a backup to `work/google/x.db`, start
> `next start --hostname 127.0.0.1 --port 3101` with `DATABASE_PATH` / `UPLOAD_DIR` pointing into
> `work/`, then run all suites with `BASE_URL=http://localhost:3101 DATABASE_PATH=work/google/x.db`.

> **Test accounts:** since 2B every API test registers throw-away accounts (`*@andon.test`, random
> password never stored or printed) and deactivates all `*@andon.test` accounts at the end via the
> masterdata CLI — so the tests must run **on the server PC** and **one at a time**.

> **Test-data contamination (known, not fixed yet):** the API tests write real `[TEST]` events and
> (deactivated) `*@andon.test` users into the database they run against (Golden Path +1 event,
> reliability +5, routing +10, auth +3 per run). Events are closed again but count in statistics,
> averages and repeat TOP 5. Before a demo, stop the server and run `npm run seed -- --reset`.
> A separate test database is a pending task.

Supervisor recovery tests (manual, see change log 2026-10-01 M2): kill server → restart; stale
server from a previous run → stopped; second supervisor → refused; failing health → restart;
missing build → rebuilt; `npm run stop` → port free.

Manual UI test: open `/operator` on a phone-width browser, `/dashboard` in another window,
`/respond/<id>` on a third — go through ACK → ACTION → CLOSE and watch the dashboard change colour.

## 11. Implemented features (Milestone 1)

- [x] Operator call screen: large touch buttons for line → process → category, description,
      optional photo (camera capture), operator name; remembers line/process per device
- [x] ANDON CALL with visible success (ANDON ID) / failure (reason + retry) states
- [x] Duplicate prevention: button lock while sending + server idempotency key (`clientRequestId`
      kept across retries, renewed only after success)
- [x] Event persisted with append-only history; transitions validated by state machine
- [x] Live dashboard: RED/YELLOW/GREEN cards, counters (open / in progress / closed today),
      auto-updating elapsed time, closed events stay GREEN for 30 min, flashing RED,
      **"서버 연결 끊김" banner** when polls fail (last data kept on screen)
- [x] Responder inbox filtered by own department (+ "all departments" toggle)
- [x] Responder detail (notification-link target): details, photo, ACK / ACTION / CLOSE with
      required comments, timeline, notification log
- [x] Routing: category → default department → all RESPONDER users of that department
- [x] `NotificationProvider` abstraction + `MockNotificationProvider`; every attempt logged;
      notification failure never blocks ANDON creation
- [x] History & analytics: count, unresolved, avg response, avg resolution, by line,
      by category, repeat-issue TOP 5, last 200 events (24 h / 7 d / 30 d)
- [x] Health endpoint, online backup script, demo seed script with reset+backup
- [x] Realistic demo data (20 events over 7 days incl. repeated "Stay Bracket 체결 이상 발견")

**Milestone 2 (in progress) — Demo-ready & recoverable**
- [x] **Photo can never block the ANDON call (H1):** server creates the event even if the photo is
      invalid / too large / cannot be saved, and returns `photoWarning`; operator screen shows
      "사진은 첨부되지 않았습니다". Photos are resized on the device to ≤ 1600 px JPEG (~0.2–0.6 MB;
      also converts HEIC where the browser can decode it). Undecodable photos are dropped with a note;
      ANDON CALL waits at most 5 s for photo processing.
- [x] **Supervised server (H2):** `npm run serve` / `status` / `stop`, auto-restart, health watchdog,
      auto-rebuild, stale-process cleanup, daily logs, Windows auto-start task scripts, RUNBOOK.md.

**Milestone 2A — Responsibility & routing foundation** (no Kakao, no escalation behaviour, no CANCEL)
- [x] Configurable master data in DB: plant, line, process, category, department, user, role (+ `npm run masterdata` CLI)
- [x] Roles OPERATOR / RESPONDER / GAP_LEADER / SUPERVISOR / ENGINEER / PLANT_MANAGER (`can_respond`, `escalation_level`)
- [x] Deterministic routing Line + Process + Category → department (routing rules + category default), decided server-side at creation and stored with the rule id
- [x] Server-side responder validation (exists, active, role may respond, responsible department)
- [x] Device audit (device id, IP, user agent) on every history row; shown in the responder timeline
- [x] Responder UI: picker lists only eligible responders of the event (from the server); inbox filtered by the server
- [x] Escalation model prepared (tables, roles, levels) — inactive, thresholds unset
- [x] Versioned schema migrations with automatic pre-migration backup (v1 → v2)

**Milestone 2B — User registration & authentication** (LOCAL only; no Google / Kakao, no escalation, no CANCEL)
- [x] Departments normalized to ME / MT / UAP / QC / PCL ("PC&L"); pre-v3 departments kept inactive with successors
- [x] Registration (name, e-mail, department, password + confirm) → active RESPONDER of that department
- [x] Login / logout / current user; server-side sessions (hashed tokens, HttpOnly SameSite=Lax cookie)
- [x] Responder actions use the logged-in user automatically (no name picker); body identity never trusted
- [x] Newly registered responders are eligible for their department's ANDONs immediately (existing routing)
- [x] Audit adds the actor's department and role at the time of the action
- [x] Pages: /register, /login, /me (내 정보 + 로그아웃); TopBar shows login state; mobile layout
- [x] Data model prepared for Google / Kakao login (`user_identity`) and for notification channels
      (`user_notification_channel`), both separate from routing
- [x] Admin CLI: role / department / activation by id or e-mail, password reset, test-account cleanup
- [x] Operator ANDON CALL unchanged — no login needed

**Google authentication provider** (implemented by Astra, reviewed and completed; LOCAL login unchanged)
- [x] Google OIDC login (openid-client, PKCE, state, nonce, signed ID token, issuer / audience / expiry)
- [x] Employee resolved by Google `sub` only; onboarding for new employees (employee ID, name,
      department, phone, KakaoTalk ID, optional company e-mail) → RESPONDER
- [x] Linking an existing local employee requires the local password and the same session
- [x] Schema v4: employee_id (permanent), contact fields, one Google per employee, google_auth_flow
- [x] Review fixes: notification address only from a verified channel (not the typed KakaoTalk ID);
      onboarding department labels / no pre-selected department; Google button hidden when not
      configured; race-safe 409 messages; safe diagnostic logging; admin `employee-id`, `unlink-google`
- [ ] **Real Google sign-in not yet tested** — needs a Google Cloud OAuth client (see RUNBOOK.md §9)

**Verified on 2026-10-01** (production build, Node 24.15, Windows 11):
`typecheck` ✔ · `lint` ✔ · `build` ✔ · `test:golden` 26/26 ✔ (earlier reports said "25/25" — that was a miscount; the test has 26 checks) · UI golden path in browser
(operator at 375 px → dashboard RED → responder ACK → dashboard YELLOW without reload → ACTION →
CLOSE → dashboard GREEN, counters updated) ✔ · append-only triggers block UPDATE/DELETE ✔ ·
server stopped: dashboard shows disconnect banner, operator sees "호출 실패" ✔ · server restarted:
data intact, operator retry succeeds ✔ · backup script ✔.

## 12. Known issues / limitations

- **Plant map:** 12 of 36 real lines are not placed yet (tray) until UAP confirms their station. Narrow AQ
  stations (≈ 80 px at 1920 wide) use ≈ 13 px names on normal tiles; at 1366 px some names break inside words.

- **A/B shift anchor not configured** (v7): the current team / GAP leader is not determined automatically
  until an authorized person enters the plant-confirmed anchor; new ANDON events store the shift as
  UNRESOLVED / SHIFT_SCHEDULE_NOT_ANCHORED until then (schema v7 is deployed; only the anchor is missing).

- **Vercel deployment (cloud demo):**
  - **Hobby plan = non-commercial use only.** Company use needs Vercel Pro (and a Turso plan check).
  - **Public URL with open registration:** anyone who finds the URL can register a RESPONDER account
    and see the dashboard. Before sharing it widely: Vercel Deployment Protection or an access gate.
  - **Polling cost:** each open dashboard makes ~1,800 requests/hour (2 s polling). Several monitors
    left open all day can exhaust free-tier function / Turso quotas — keep the plant monitor on the
    plant server.
  - **Latency:** functions and DB are in the US east (`iad1` / `aws-us-east-1`): ~0.5–0.6 s per warm
    API call from Korea, ~1.5 s on a cold start. Fine for a demo; the plant server on the LAN is faster.
  - Preview deployments share the production DB and Blob store.
  - Turso / Blob backups are the providers' (Turso point-in-time restore); `npm run backup` covers the
    local SQLite file only.

- **No authentication.** Responder picks a name from a list (stored per device). Anyone on the
  LAN can act. Acceptable for the prototype; needs SSO/AD or PIN before production use.
- **Notifications are mock only** (console + `notification_log`). Link base URL comes from
  `APP_BASE_URL` — must be set to the LAN address for phones.
- **Transition retry after a lost response**: if ACK succeeded but the response was lost, pressing
  ACK again returns a 409 message ("현재 상태에서는…") — data is correct, the screen refreshes itself.
- **No sound** on the dashboard for new RED events yet (browsers block autoplay without interaction).
- Photos are resized on the device; photos sent by other clients (API) are stored as received
  (≤ 10 MB, JPG/PNG/WEBP/HEIC). File content is not verified against the declared type.
- **Google login has only been tested offline** (fake Google with signed test tokens). Real Google
  sign-in needs a Google Cloud OAuth client and an exact redirect URI. Google allows plain HTTP only for
  `localhost`: phones on the plant LAN need an **HTTPS host name** for Google login.
- **Any Google account can onboard** (no company-domain restriction) and **employee IDs are
  self-asserted** (not checked against HR). An unassigned employee ID could be taken by someone else;
  administrators can pre-assign employee IDs (`user employee-id`) to prevent that.
- **Authentication is a prototype (LOCAL accounts + Google), not enterprise SSO.** Limitations:
  - **Plain HTTP on the LAN**: the session cookie and the password at login travel unencrypted and can
    be sniffed on the Wi-Fi. Use HTTPS (then `COOKIE_SECURE=true`) before production.
  - Anyone can self-register with any e-mail and pick any department (no e-mail verification, no
    approval step). The role is fixed to RESPONDER, but a person can register for a department they do
    not belong to. Mitigation today: administrators review `npm run masterdata -- list` and deactivate.
  - Login throttling is in memory, per e-mail + IP (reset on restart; distributed guessing is not limited).
    Registration is not rate-limited. Registration reveals whether an e-mail is already registered (409).
  - No self-service password change / reset; administrators reset with `user reset-password`.
  - Sessions last 7 days with no idle timeout and no "log out everywhere" (password reset does end all
    sessions of that user). Old sessions are not purged from `user_session`.
  - Event detail shows names of eligible responders to anyone on the LAN.
- **Device identity is not authentication**: the device id lives in browser storage and the IP comes
  from `x-forwarded-for`, which a client can forge. They are audit hints only.
- **SAFETY → UAP and EHS → UAP are prototype decisions** (no safety department among the five) — confirm.
- **No category routes to ME** yet — add routing rules once the plant defines ME's responsibilities.
- Demo users created before 2B (품질 담당 A, …) have no login; they remain for history and the seeder.
- Browsers that used the 2A responder picker still have unused `andon.responder.*` keys in localStorage
  (harmless, no credentials).
- **Operators have no accounts**: CREATE rows have `user_id` NULL and the typed operator name.
- **CANCEL (false call) is not implemented** — pending requirement (see §14). A mistaken ANDON must be
  ACKed and CLOSEd and counts in statistics.
- **Escalation is not active**: tables exist, nothing reads them, thresholds are NULL.
- Existing events keep the department they were routed to at creation; changing routing rules affects
  new ANDONs only.
- User / rule ids in the existing dev DB have gaps (ids were consumed by start-up seeding before this was
  fixed) — ids carry no meaning.
- **API tests write into the live DB** (`[TEST]` events count in statistics). Run
  `npm run seed -- --reset` before a demo.
- **Auto-start task not yet registered on any PC** — scripts validated with `-DryRun` only.
- **Not yet observed:** on a real Windows hard-kill of the supervisor (Task Manager), whether the
  child server survives as an orphan. Either way the next supervisor start stops it (tested via a
  stale `server.pid`) and `npm run stop` cleans up.
- `package.json` `engines` says `>=22.13`, but the scripts need Node ≥ 22.18 (native TypeScript).
  Use Node 24.
- Master data (lines/processes/users) has no admin screen yet — edit `masterData.ts` (new rows only)
  or the DB directly.
- Single server process: if the PC hosting it goes down, the system is down (see §14 failover).
- Windows: SQLite cannot open paths longer than 260 characters — install the project in a short
  path such as `C:\andon` (current location).

## 13. Important design decisions

1. **SQLite (`node:sqlite`) instead of PostgreSQL/MySQL** — no DB server to install or fail;
   whole state is one file; backup = copy. Migration path: the SQL is plain and isolated in
   `andonService.ts`/`db.ts`, so moving to PostgreSQL on a company server is a contained change.
2. **Polling instead of WebSockets/SSE** — fewer failure modes, automatic recovery after server
   restart, trivial behind proxies. Load is negligible at plant scale.
3. **Append-only transition table + cached current state** — history can't be silently overwritten
   (DB triggers), current state is still a single fast query.
4. **Idempotency key on create** — the critical "worker presses button, network blips" case cannot
   produce duplicate ANDONs.
5. **Notification is fire-and-forget after commit** — ANDON creation never fails because of the
   messaging channel; every attempt is logged for traceability.
6. **Routing by category → department** (`category.default_department`) — configurable in DB.
7. **Strict state machine**: CLOSE requires prior ACKNOWLEDGE and a corrective action text.
8. **Korean-first UI with bilingual status terms** (발생 OPEN / 접수 ACKNOWLEDGED / 조치중 IN PROGRESS / 완료 CLOSED).
9. **No `tsx`**: scripts run with Node's native TypeScript support; server modules use explicit
   `.ts` import extensions (`allowImportingTsExtensions`) so they can be shared with scripts.
10. **The ANDON signal never depends on the attachment.** The photo is best-effort: resized on the
    device, and any server-side photo problem degrades to "created without photo + warning".
11. **Own small supervisor instead of NSSM/pm2** — no extra binaries to download or approve on a
    plant PC; Windows Task Scheduler (built in) supervises the supervisor. It only ever stops
    processes proven to be this project's (folder in command line, or `/api/health` reports this DB).
12. **Tool scope is explicit** (`tsconfig.json` include, `eslint src scripts`) so stray copies of the
    project inside the folder cannot break typecheck / lint / build again.
13. **Old departments are kept, not renamed** (v3): new codes ME / MT / UAP / QC / PCL; old codes stay
    as inactive rows with `successor_code`. History keeps its original department; open old events stay
    actionable via the successor. Users, category defaults and routing rules (configuration) move to the
    new codes. Internal code `PCL`, displayed "PC&L".
14. **Server-side sessions, not JWT**: a random token in an HttpOnly cookie, only its hash in the DB;
    revocation and deactivation take effect immediately; no signing secret to manage.
15. **scrypt from Node's crypto** for passwords (no native modules to install on plant PCs, no custom crypto).
16. **Login identity, notification identity and routing are three separate things**:
    `user_identity` (how you log in), `user_notification_channel` (where you are messaged), `app_user`
    department/role (what you are responsible for).
17. **Google is an additional provider, linked only with proof of both identities**: an existing
    employee is never claimed by Google e-mail, company e-mail, name or employee ID; linking needs the
    Google login AND the local password in the same session. The permanent employee key is the
    `app_user` row (+ employee ID), never a Gmail address.

## 14. Pending tasks

**Milestone 2 — Demo-ready & recoverable** (from the Milestone 1 review)
- [x] H1 photo never blocks the call · [x] H2 supervisor / auto-start / runbook
- [ ] Register the auto-start task on the demo/plant PC (needs admin; `-AtStartup`)
- [ ] Separate test database for `test:golden` / `test:reliability`; `CANCELLED` (false call) outcome excluded from KPIs
- [x] Validate responder identity server-side; store user id, device id, IP, user agent per transition (H4) — Milestone 2A
- [x] User registration, login, sessions; responder actions bound to the logged-in user — Milestone 2B
- [ ] Confirm SAFETY / EHS → UAP with the plant; define ME routing rules
- [ ] HTTPS on the plant server (then `COOKIE_SECURE=true`)
- [ ] Self-service password change; admin approval or e-mail verification for registrations (if required)
- [x] Google login (provider GOOGLE) — implemented, offline-tested
- [ ] Configure a real Google Cloud OAuth client and test real Google sign-in (HTTPS host for phones)
- [ ] Optional: restrict Google onboarding (company domain / admin approval / HR employee-ID list)
- [ ] Kakao login (provider KAKAO) — not started
- [ ] **CANCEL / false-call outcome** (pending requirement): new terminal status or action with a reason,
      excluded from KPIs; must use the same responder validation and device audit
- [ ] Small fixes: `limit` validation (500 on `?limit=abc`), `nosniff` + `poweredByHeader: false`,
      notification try/catch, schema `user_version` check, Node engines ≥ 22.18, backup photos too

**Milestone 3 — Notifications (H3)**
- [ ] `KakaoNotificationProvider` (credentials from `.env` only), register in `createProvider()`
- [ ] Map users → Kakao recipient (`app_user.kakao_id`); correct `APP_BASE_URL` (LAN IP + port)
- [ ] Retry policy for failed notifications (re-send from `notification_log` FAILED rows)

**NEXT PLANNED MILESTONE — Reaction Rules (plant ANDON procedure)** — requirements and proposed
design in **Appendix A**. Not started. Do not code before the open business decisions (A.10) are
answered by UAP and the real line / process master data has been delivered.
- [ ] Confirm open business decisions OBD-1 … OBD-17 (Appendix A.10) with UAP
- [x] Load real lines from UAP — 36 lines + supervisor / A / B GAP leader per line (schema v6, 2026-10-02)
- [ ] Load real processes per line (replaces the placeholder "공정 미지정")
- [ ] Implement trigger / reaction-rule master data (revisioned), trigger selection in the operator
      call, next-action guidance, rule reference stored per ANDON, arrival / QRCI milestones
- Equipment master data (Appendix B) is **optional** for the first pilot — do not block this
  milestone waiting for complete equipment data

**Pending plant inputs (plant map, 2026-10-02)**
- [ ] Confirm the station of the 12 unmapped lines (table in §6 "Shop-floor display v2"; candidates in
      `UNMAPPED_LINES`), and that HE / CE BENDING = the AQ / AP BENDING cells of page 2
- [ ] Meaning of the "CAPACITY LINE" label on page 2 (not drawn)
- [ ] KAPPA EU7 station (KAPPA EU7 + GAMMA TURBO 1차): is the DB line TURBO #2 EU7, TURBO#1, or both?

**Pending plant inputs (line ownership, 2026-10-02)** — nothing of this was invented:
- [ ] Process master per real line (Line → Process)
- [ ] Trigger master and defect / problem types
- [ ] ME responsibility rules; HSE / safety routing (SAFETY → UAP is still a prototype decision)
- [x] A / B shift clock times and rotation — confirmed 2026-10-02 (08:00 / 20:00, weekly swap Monday 08:00,
      Asia/Seoul); modelled in schema v7 (`shift_schedule`)
- [ ] **Shift ANCHOR** — which team is on DAY in one named week (a Monday). Needed before automatic A/B
      determination is authoritative; enter via `/admin/shifts` or `masterdata shift anchor`
- [x] **v7 production rollout** (Turso + Vercel + local plant DB) — done 2026-10-02, anchor left NULL
- [ ] **PENDING PLANT CONFIRMATION — BENDING shift B leaders per line** (sheets differ, see §6). Kept exactly as
      imported from UAP(Line 구분), locally and in the cloud; not reconciled
- [ ] Reaction-rule thresholds beyond the documented procedure (Appendix A.10)
- [x] Cloud receives the personnel assignments — decided and done 2026-10-02 (names, roles, assignments only)
- [x] Prototype lines hidden from operators — decided; done in the cloud 2026-10-02 (`line.active = 0`).
      Local plant DB: not changed yet (`npm run masterdata -- line deactivate TGDI1|TGDI2|MUF1`; note that
      `test:golden` looks for TGDI1 in `/api/meta`, so run API tests on a copy where it is active)

**Milestone 4 — Escalation / proactive (rule-based first, AI later)** — data model prepared in 2A
- [ ] Configure `escalation_step.after_minutes` per policy (no defaults in code) and activate
- [ ] Periodic check in the server process; per-event escalation log; notify (department, role) targets
- [ ] Background rule check (e.g. every 30 s): not acknowledged in 5 min → notify manager
- [ ] Same line/process/category ≥ 3 in a shift → notify quality lead
- [ ] Record alerts in an `alert` table; humans decide on high-impact actions (no auto line stop)

**Demo readiness (before 2026-10-22)**
- [ ] Run on the target demo PC + plant Wi-Fi; set `APP_BASE_URL`; test with real phones
- [ ] Optional dashboard sound for new RED (with a "sound on" button)
- [ ] Demo script / rehearsal; `npm run seed -- --reset` right before the visit

**Later**
- [ ] Authentication (company SSO / AD) and role-based permissions
- [ ] Master-data admin screen
- [ ] PWA manifest / home-screen install
- [ ] Offline/failover (document only for now): local queue on operator device, standby server
      with periodic DB copy
- [ ] Shift-based statistics, CSV export

## 15. Next recommended action

00. **A/B shift anchor (v7 deployed 2026-10-02):** when UAP confirms which team is on DAY in one named week
    (a Monday), an authorized SUPERVISOR / PLANT_MANAGER enters it on `/admin/shifts` (or
    `npm run masterdata -- shift anchor <YYYY-MM-DD> <A|B>`; audited) on BOTH databases — local plant DB and
    cloud (Turso) are separate. Until then every new ANDON stores UNRESOLVED / SHIFT_SCHEDULE_NOT_ANCHORED.
    Future schema changes: same order as the v7 rollout (dry run → `db:migrate` → push; local: stop → build
    → serve with automatic backup).

0. **Line ownership (2026-10-02):** cloud has the assignments (now on v7). Confirm the BENDING shift B
   leaders and the A / B shift times with UAP; deliver the Process / Trigger master. For every future schema
   change keep the order: `db:verify-remote-migration` → `db:migrate` (both via `vercel env run -e production
   --`) → push. Expect a few minutes in which the old deployment refuses the new schema.

1. ~~Move the project to a permanent short path and put it under git~~ — done 2026-10-01 (`C:\andon`).
2. Decide where the demo server runs; on that PC follow RUNBOOK.md §8 (first-time setup) and
   register auto-start with `-AtStartup`. Then reboot it once and confirm the system comes back alone.
3. Let the real responders register (QC, MT, UAP, PC&L, ME) and assign leader roles with
   `npm run masterdata`; confirm SAFETY → UAP and define ME routing. Then: test-data separation + CANCEL, then Milestone 3 (Kakao), then escalation. Walk the Golden Path with real phones and the actual dashboard monitor.

## 16. Change log

| Date | Change |
|---|---|
| 2026-10-02 | Shop-floor display v2 — plant map ANDON on `/dashboard` (approved, merged, deployed): layout config from `layout.pptx` page 2 (24 / 36 lines placed, 12 explicitly unmapped in a tray), line states in place (red / amber / normal, count badge), active panel, shift chip (UNRESOLVED without anchor), board API `shift` field; previous cards at `/dashboard/list`. No schema change. Verified: typecheck / lint / build ✔; isolated copy: test:google 48/48, test:auth 42/42, test:routing 39/39, test:golden 26/26, test:reliability 6/6, test:lines 70/70, test:shifts 54/54, test:display 33/33; browser 1920 × 1080 without scrolling, live NORMAL → OPEN → ACK → CLOSE without reload, disconnect warning; screenshots 1920 × 1080 / 1366 × 768 / tablet. |
| 2026-10-02 | v7 production rollout: branch merged into main (fast-forward, 4 commits); Turso dry run passed (366 rows unchanged, rolled back) → `db:migrate` v6 → v7 (FK 0; all 366 pre-existing rows unchanged vs. checksum snapshot; `verify:lines` 36/36 × 3, 35 employees, no workbook-derived contact value); pushed `f5fc968`, Vercel Ready (~1.5 min of refused requests between migration and deploy); production: health, `/api/meta` without shift / personnel fields, `/api/admin/shift-schedule` GET / PUT 401 without login or with a forged session, foreign Origin 403, `/admin/shifts` 200, schedule unanchored with empty audit; ANDON creation through the service in a rolled-back transaction → OPEN, routed to MT, shift UNRESOLVED / SHIFT_SCHEDULE_NOT_ANCHORED, supervisor recorded (no test event left). Local plant DB: stop → build → serve, automatic backup `andon-pre-migration-v6-to-v7-…`, v7; 136 events / 440 history / 175 notifications / 92 users / 108 assignments unchanged, anchor NULL. **Anchor not configured.** |
| 2026-10-02 | A/B shift schedule, schema v7 — implemented on branch `feature/shift-schedule-v7` (deployed later the same day, see the row above): pure resolver (Asia/Seoul, 08:00 / 20:00, weekly swap at Monday 08:00, operational date = shift start, SHIFT_SCHEDULE_NOT_ANCHORED without anchor); `shift_schedule` (rule, anchor empty) + append-only `shift_schedule_audit`; shift snapshot on new ANDON events (never blocks the call; old events NULL); `/admin/shifts` + `/api/admin/shift-schedule` (view / change roles, audited), `masterdata shift show / anchor`. Verified on an isolated copy of the local DB: v6 → v7 with automatic backup, all 136 events / 440 history / 175 notifications / users / 108 assignments unchanged, old events snapshot NULL, anchor NULL; Turso-compatible v6 → v7 (emulation); typecheck / lint / build ✔; test:google 48/48, test:auth 42/42, test:routing 39/39, test:golden 26/26, test:reliability 6/6, test:lines 70/70, test:shifts 54/54; browser: `/admin/shifts` as SUPERVISOR. |
| 2026-10-01 | Milestone 1: project scaffold (Next.js 16, node:sqlite), data model + state machine, operator / dashboard / responder / history screens, mock notification provider, demo seed, backup, health check, automated Golden Path test. Verified end-to-end (see §11). |
| 2026-10-01 | Moved project to `C:\andon` (permanent location), fresh `npm install`, git repository initialised. Re-verified typecheck / lint / build / `test:golden` at the new location. |
| 2026-10-01 | Recovery: removed an accidental nested copy (`digital-andon/`) that broke typecheck/lint/build; tool scope made explicit (commit `a702b41`). |
| 2026-10-01 | Milestone 2 part 1 — H1: photo problems never block the ANDON call (server warning instead of 400; on-device resize to ≤1600 px JPEG; `test:reliability`). H2: `scripts/supervisor.ts` (`npm run serve/status/stop`), restart + watchdog + auto-rebuild + stale-process cleanup + daily logs, Windows auto-start scripts, RUNBOOK.md. Verified: typecheck/lint/build ✔, `test:golden` 26/26, `test:reliability` 6/6, browser: 12.2 MB 4000×3000 photo → 631 KB 1600×1200 JPEG; undecodable photo → note, call still possible; supervisor: crash → back in 2 s, stale server stopped, double start refused, failing health → restart after 3 checks, missing build → rebuilt (healthy 5 s after start), stop → port free. Auto-start task validated by dry run only (not registered). |
| 2026-10-01 | Milestone 2A — responsibility & routing foundation: schema v2 with migration runner + pre-migration backup; plant / role / routing_rule / escalation_policy / escalation_step tables; app_user with role FK (MANAGER → SUPERVISOR); deterministic routing (process rule > line rule > category default) stored per event; server-side responder validation; device id / IP / user agent on every history row; eligible-only responder picker; `npm run masterdata`; `npm run test:routing`. Verified: fresh DB + seed, live-DB copy v1→v2 (40 events / 136 history rows preserved), live DB migrated with backup; typecheck / lint / build ✔; test:routing 38/38, test:golden 26/26, test:reliability 6/6; mobile UI ACK shows device + IP + "Android · Chrome" in history. |
| 2026-10-01 | Milestone 2B — user registration & authentication: schema v3 (departments ME / MT / UAP / QC / PCL with old codes kept inactive + successor; app_user rebuilt with e-mail, non-unique name; user_identity, user_session, user_notification_channel; actor department / role on history rows); scrypt passwords; server-side sessions (HttpOnly, SameSite=Lax); /register, /login, /me; responder actions only as the logged-in user; masterdata CLI admin commands; tests use registered throw-away accounts. Migration verified on a copy and on the live DB: events 73 / history 239 / notifications 67 / users 10 unchanged, event-department and history checksums identical. Verified: typecheck / lint / build ✔; test:auth 42/42, test:routing 39/39, test:golden 26/26, test:reliability 6/6; browser (mobile): register → back to the event → ACK / ACTION / CLOSE as the logged-in QC user → timeline shows name, QC · 품질 · RESPONDER, device, IP, browser; QC user on an MT ANDON: no buttons + 403 from the API; logout. |
| 2026-10-02 | Cloud v6 rollout: baseline abdee5e, Turso confirmed v5 and app healthy; dry run passed (142 rows unchanged, rolled back); `db:migrate` v5 → v6 (FK 0; all 142 pre-existing rows unchanged vs. a checksum snapshot); `import:uap --allow-remote`: 35 employees, 108 assignments (names, roles, areas, assignments only); `verify:lines` on Turso: 36 lines, 7 areas, supervisor / A / B 36/36 each, one record per person, imported records without any contact field or login, no workbook-derived contact value anywhere (a positive control detected a planted value; the own login e-mail of one self-registered account is listed separately); demo lines hidden (`line.active = 0`, only that column changed); then v6 pushed and deployed (~5 min of refused requests between migration and deploy). Production: `/api/meta` 36 lines / 7 areas, no personnel fields; `/api/admin/lines` 401 without / with a forged session; board / history / stats / event detail 200 with the 20 demo-line events intact; operator page 7 area groups, no demo lines; ANDON creation verified through the service inside a rolled-back transaction (no test event; still 20 events / 70 history rows). New: `masterdata line activate|deactivate`, `npm run verify:lines`. |
| 2026-10-02 | Line master + UAP line ownership (schema v6): `uap_area`, `line.uap_area_code`, `process.placeholder`, `shift` (A / B, times NULL), `app_user.import_key`, `line_assignment` (SUPERVISOR / GAP_LEADER by shift, effective dates, active). 36 real lines in 7 areas + placeholder process each; `npm run import:uap` (workbook parser with cross-check of both sheets; contact columns never read), `masterdata lines / assign / user set-login`; operator line choice grouped by area with automatic placeholder process; `/admin/lines` + `/api/admin/lines` (login + GAP_LEADER / SUPERVISOR / ENGINEER / PLANT_MANAGER; names only); `/api/meta` without people. Migration: local live DB copy v5 → v6 (136 events / 440 history / 175 notifications / 57 users unchanged; +36 lines, +36 processes), then the live local DB (automatic backup, re-verified against it); Turso production: dry run in a rolled-back transaction (142 rows unchanged, nothing changed afterwards) — **Turso not migrated** (app not pushed). Workbook imported into the local live DB: 35 employees, 108 assignments, 3 warnings (BENDING shift B). Verified: typecheck / lint / build ✔; isolated v6 server: test:google 48/48, test:auth 42/42, test:routing 39/39, test:golden 26/26, test:reliability 6/6, test:lines 70/70; browser (mobile): operator areas + CE BENDING call with "공정 미지정" → MT; /admin/lines 403 for RESPONDER, 7 areas / 36 lines for SUPERVISOR. |
| 2026-10-01 | Vercel deployment: async DB layer (`sql.ts`: node:sqlite file driver + Turso libSQL driver), schema v5 (`login_throttle` in the DB), photos in private Vercel Blob, notifications via `after()`; Turso keeps the schema version in `schema_meta` (it rejects `PRAGMA user_version = …`). Created Vercel project + GitHub auto-deploy, Turso `andon-db`, Blob `andon-photos`; migrated Turso v0→v5 and seeded 20 demo events. Verified on Turso: FK enforcement, transaction rollback, append-only triggers (UPDATE / DELETE rejected); Blob: save / read back identical bytes / unauthenticated URL 403 / delete; deployed https://forvia-yeongcheon-andon.vercel.app: `/api/health` backend remote, dashboard renders demo data. NOT verified on Vercel: login + ACK / ACTION / CLOSE and photo upload through the deployed UI (would create accounts / test events in the demo DB). Local plant server unchanged (SQLite file, v5). |
| 2026-10-01 | Google authentication provider (Astra implemented; reviewed and completed after Astra's usage limit): schema v4 (employee_id permanent + unique, phone, company_email, user_identity.provider_email, one Google identity per employee, google_auth_flow); Google OIDC via openid-client (PKCE, state, nonce, JWKS signature, issuer / audience / expiry); onboarding; linking with local password re-check bound to the session. Review fixes: notification address only from verified channel; onboarding department labels; Google button hidden when unconfigured; 409 on races; safe logging; admin employee-id / unlink-google. Migration v3→v4 verified on a fresh copy of the live DB (all old rows / columns unchanged) and then on the live DB. Isolated v4 regression: test:google 48/48, test:auth 42/42, test:routing 39/39, test:golden 26/26, test:reliability 6/6. Real Google sign-in NOT tested (no Google Cloud client configured). |


---

## Appendix A — Plant reaction-rule requirements (next milestone, NOT implemented)

> Source: the plant ANDON procedure workbook (reviewed 2026-10-01; trigger sheets "TRIGGERS (한글판)"
> and the newer "TRIGGERS (한글판) (2)"). These are the **authoritative business requirements** for the
> next ANDON reaction-rule milestone. Nothing in this appendix is implemented yet. Items marked
> **OBD-n** are open business decisions that must be confirmed by UAP before coding (A.10).

### A.1 Architecture finding

The plant process is not just `Category → Department → Responder`. It is:

```
Trigger → Operator self-action → GAP Leader call / action → time / repetition / condition threshold
        → ANDON activation → Responsible Department → required response (gather ≤ 10 min) → QRCI
```

The current routing model stays and is **extended** with a configurable Trigger / Reaction Rule model.
Rules are master data (revisioned), never hard-coded in React components.

### A.2 Trigger groups and triggers (as written in the procedure)

Trigger group = WHAT happened (business grouping). Department = WHO is responsible. They are not the
same thing and are not merged.

| Code | Group | Trigger | Operator | GAP Leader | ANDON when | QRCI |
|---|---|---|---|---|---|---|
| Q1 | QUALITY ISSUE | 라인 정지 기준 외 불량 | Stop the line, call GAP Leader | Investigate after line stop; clean jig / jig clamp contamination; replace tip if needed; clean critical area (e.g. welding); produce one additional part | Defect repeats → QUALITY ANDON | yes |
| Q2 | QUALITY ISSUE | 라인 정지 기준 내 불량 | Stop line; resolve per standard work / documented cause; if it recurs after removing the cause → follow line-stop criteria | Confirm the actions | "If standard procedure was followed" → QUALITY ANDON (OBD-10) | yes |
| Q3 | QUALITY ISSUE | 부품의 품질문제 | Try another suspect component with its mating component; if still defective call GAP Leader; verify defective component together | Change to another lot; attach red label to defective component | Defect repeats after lot change → QUALITY ANDON | yes |
| L1 | LOGISTICS ISSUE | 자재 결품 | Check / start the last box in the flow rack; call GAP Leader | Call small-train / material delivery; **not arrived within 10 min → call PC&L GAP Leader** | Material exhausted AND line stops → material-shortage ANDON | not stated |
| L2 | LOGISTICS ISSUE | 이종 부품 | First box wrong → check next box. Next box correct → call GAP Leader to remove the wrong box. Next box also wrong → call GAP Leader immediately | Stop the remaining line as required | Immediately (next box also wrong) → material / logistics ANDON | not stated |
| L3 | LOGISTICS ISSUE | 파렛트 결품 | No empty pallet → call GAP Leader | Request empty pallet from small-train / forklift logistics | All pallets full / none available → logistics ANDON | not stated |
| E1 | EQUIPMENT ISSUE | 설비고장 | Simple recovery first (jig 5S, sensor check, …); cannot repair OR > **5 min** → call GAP Leader | Stop line, investigate, attempt repair | GAP Leader cannot repair OR repair > **10 min** → EQUIPMENT ANDON | not stated |
| E2 | EQUIPMENT ISSUE | 반복되는 설비 문제 | — | Stop line, investigate and repair | Same issue **≥ 2 / shift** (newer sheet) — older sheet says **≥ 3 / shift** (**OBD-1**); if unable to resolve → EQUIPMENT ANDON | yes |
| H1 | HSE ISSUE | 니어미스 / Fr2t / Fr1t / Fr0t / 중대재해 | Leave everything as-is; move outside the line; call GAP Leader. If injured and unable to move: call loudly or phone a nearby colleague / GAP Leader | Activate ANDON; in an emergency arrange vehicle / ambulance per procedure; check operator condition; inform HSE Coordinator | GAP Leader activates (immediately) | yes |

No additional HSE automation or routing is assumed beyond this text (OBD-2).

### A.3 Global reaction rule

After ANDON activation, the required participants must **gather at the line within 10 minutes** and
conduct **QRCI**. The system should eventually measure: ANDON called_at → ACK at → arrival / response
at → QRCI started_at → ACTION at → CLOSED at, and 10-minute compliance (OBD-6, OBD-7, OBD-16).

### A.4 Coexistence with the current state machine (proposal — no change to OPEN / ACKNOWLEDGED / IN_PROGRESS / CLOSED)

- **Keep the four statuses and all existing transitions exactly as they are.** Existing history, tests
  and statistics stay valid.
- Add **milestones** as a separate append-only table (`andon_milestone`: event, type, user, department,
  role, device, time), e.g. `ARRIVED_AT_LINE`, `QRCI_STARTED`, later `QRCI_COMPLETED`. A milestone never
  changes the status; it records a fact with the same audit fields as transitions.
- Derived timings: called_at = event.created_at; ack_at = ACKNOWLEDGE transition; arrival_at /
  qrci_started_at = first milestone of that type; action_at = first ACTION; closed_at = CLOSE.
  10-minute compliance = arrival_at (or qrci_started_at, OBD-6) − created_at ≤ 10 min.
- Allowed while ACKNOWLEDGED / IN_PROGRESS only; recording ARRIVED_AT_LINE could optionally imply ACK
  for a responder who has not acknowledged yet (decision OBD-7) — still as a normal ACKNOWLEDGE
  transition, so the state machine itself is untouched.
- Pre-ANDON steps (operator self-action, GAP Leader call, 5 / 10-minute timers) are **guidance** in the
  first version; whether the system also records them (e.g. a "GAP Leader called" record before the
  ANDON exists) is OBD-8.

### A.5 Proposed data model (minimal — not a generic workflow engine)

| Table | Purpose / key fields |
|---|---|
| `trigger_group` | code (QUALITY / LOGISTICS / EQUIPMENT / HSE), names, sort, active |
| `trigger` | code (Q1 … H1), group, name_ko / name_en, active. Stable identity of "what happened" |
| `reaction_rule` | **revisioned**: trigger, optional line / process scope (override, like routing_rule), `revision`, `effective_from`, `effective_to` (NULL = current), `active`, `qrci_required`, `responsible_department` (NULL = use routing until confirmed), `source_ref` (workbook sheet / row), `approved_by`. Unique (trigger, scope, revision) |
| `reaction_step` | rule, `step_no`, `actor_role` (OPERATOR, GAP_LEADER, PCL_GAP_LEADER?, …), `instruction_ko` (short, shown on screen), `threshold_type`, `threshold_value`, `threshold_unit`, `outcome` (NEXT_STEP / CALL_GAP_LEADER / CALL_OTHER / ACTIVATE_ANDON / QRCI) |
| `andon_event` (+ columns) | `trigger_code`, `reaction_rule_id` (the exact revision used at creation), `shift_code` / shift date (for per-shift analytics) |
| `andon_milestone` | append-only arrival / QRCI facts (A.4) |
| `shift` | shift definitions (needed for REPEAT_PER_SHIFT, OBD-5) |

Threshold types (only what the procedure needs): `IMMEDIATE`, `ELAPSED_MINUTES` (E1 5 / 10 min, L1 10
min), `REPEAT_PER_SHIFT` (E2), `REPEAT_AFTER_ACTION` (Q1 "defect repeats", Q3 "repeats after lot
change"), `LINE_STOP`, `MATERIAL_EXHAUSTED` (L1), `MANUAL_CONFIRMATION` (GAP Leader judgement: "cannot
repair", "standard procedure followed", "all pallets full").

Engine scope: "If X happens, actor Y performs action Z; if threshold T is reached, call / activate ANDON"
— evaluated mostly by people (guidance + confirmation buttons); the system itself only evaluates
`REPEAT_PER_SHIFT` (counting events of the same trigger / line / process / equipment in the shift) and
`ELAPSED_MINUTES` reminders. No arbitrary workflow designer.

Routing: Trigger groups map approximately to today's categories (QUALITY → QUALITY, LOGISTICS →
MATERIAL, EQUIPMENT → MAINTENANCE, HSE → SAFETY); category stays for routing and history
compatibility. Expected default departments QUALITY ISSUE → QC, LOGISTICS ISSUE → PC&L, EQUIPMENT
ISSUE → MT are **not hard-coded** until confirmed (OBD-3); HSE (OBD-2) and ME (OBD-4) are open.
**Actor role ≠ responsible department**: UAP operators / GAP Leaders act first, but that does not make
UAP the responsible department.

Model chain: `Plant → Line → Process → Trigger → Reaction Rule (revision) → Responsible Department →
Eligible Responders`, with optional line / process-specific rule overrides (same pattern as
`routing_rule`).

### A.6 UI principle

Operator / MOD screen stays minimal: **LINE → PROCESS → PROBLEM (trigger)** → show only the **next
action** for that role, e.g. 설비 이상 → "지그 5S / 센서 확인" · "5분 이상 해결되지 않으면 GAP Leader 호출".
GAP Leader sees only GAP-Leader steps. Never show the whole procedure document during an abnormality.

### A.7 Analytics to keep possible

ANDON count by line, process, trigger, trigger group, department, shift; repeat issues; response and
resolution time; 10-minute QRCI compliance; repeated-equipment threshold hits; material-shortage
frequency. Requires: trigger_code + rule revision + shift stored on the event, milestones table.

### A.8 Revision control

Reaction rules are controlled plant procedures: revision, effective date, active / inactive, approver,
source reference. Each ANDON stores the rule revision it was created under; a rule change never alters
the meaning of historical ANDONs (same principle as routing_rule_id on events).

### A.9 Line / process master data

**Lines: delivered** (2026-10-02, workbook 261001) — 36 real UAP lines in 7 areas with supervisor and
A / B GAP leaders, imported in schema v6 (§6 "Line master and line ownership"). **Processes, triggers
and defect types: still missing** — each real line has only the placeholder process "공정 미지정".
The demo lines (T-GDI 1, T-GDI 2, Muffler 1) are prototype placeholders. **Do not invent processes.**

### A.10 Open business decisions (confirm with UAP before coding)

| ID | Question |
|---|---|
| **OBD-1** | **Source conflict E2**: older sheet "TRIGGERS (한글판)" says repeated equipment issue **≥ 3 / shift**; newer sheet "TRIGGERS (한글판) (2)" says **≥ 2 / shift**. Candidate = ≥ 2 (newer), **not confirmed**. Which is valid, and is the older sheet withdrawn? |
| OBD-2 | HSE ISSUE: which department is responsible / notified (no HSE department among ME, MT, UAP, QC, PC&L; today SAFETY → UAP is a prototype placeholder)? How is the HSE Coordinator represented (role? person?) |
| OBD-3 | Confirm default responsible departments: QUALITY → QC, LOGISTICS → PC&L, EQUIPMENT → MT |
| OBD-4 | ME responsibilities: which triggers / lines / processes route to ME? |
| OBD-5 | Shift definitions (start / end times, shift codes) for "per shift" counting |
| OBD-6 | "Required participants must gather within 10 minutes": who exactly per trigger group, and is compliance measured by arrival or by QRCI start? |
| OBD-7 | Who records arrival / QRCI start (responder tap "현장 도착", GAP Leader, either)? May arrival imply ACK? |
| OBD-8 | Should pre-ANDON stages (operator self-action, GAP Leader called, 5 / 10-minute timers) be recorded in the system, or only shown as guidance? |
| OBD-9 | L1 "not arrived within 10 min → call PC&L GAP Leader": is this an ANDON, a notification, or a phone call outside the system? |
| OBD-10 | Q2 wording "If standard procedure was followed, activate QUALITY ANDON" — activate when the standard procedure was followed **and the defect persists**? Please confirm the exact condition |
| OBD-11 | Q1 "produce one additional part; if defect repeats": repeat = defect on that one additional part? Q1 is "outside line-stop criteria" yet the operator stops the line — confirm |
| OBD-12 | E1 timers (operator 5 min, GAP Leader 10 min): measured from when, and should the system run / remind these timers or only display them? |
| OBD-13 | H1 severity (near miss / Fr2t / Fr1t / Fr0t / 중대재해): capture severity on the ANDON? Any different handling per severity (no rules invented)? |
| OBD-14 | Today's categories PRODUCTION and OTHER have no trigger group in the procedure: keep, remap, or retire? |
| OBD-15 | E2 "same issue": same equipment / process / trigger / defect text? Needed for automatic repeat counting |
| OBD-16 | QRCI: record start / completion in the system, link to the QRCI document, or keep outside? |
| OBD-17 | Which roles are "GAP Leader" per line (UAP GAP Leader vs PC&L GAP Leader in L1) — one role with department, or separate roles? |

---

## Appendix B — Reference design: legacy FORVIA DMC ANDON (reference only, NOT implemented)

> Source: a legacy FORVIA DMC / SAP ANDON configuration document (reviewed 2026-10-01). Used only as
> reference architecture. **No SAP, DMC, PLC or MES integration** — Digital ANDON stays standalone,
> external-network based and mobile-first.

Concepts to preserve in future designs:

1. **Internal id ≠ display name** for equipment (stable internal identifier + human-readable name),
   the same pattern already used for departments (`PCL` shown as "PC&L").
2. **Hierarchy Plant → Line → Process → Equipment** (equipment as an optional level under process).
3. **Equipment status**: active / inactive, or ANDON include / exclude (monitored or not).
4. **Never delete historical equipment** when it leaves the monitoring scope — deactivate it, so past
   ANDONs keep a valid reference (same rule as users and departments).
5. **Configurable KPI / target values** (e.g. response-time targets, repeat thresholds) as master data,
   not hard-coded numbers — consistent with Reaction Rule thresholds (Appendix A.5).
6. **Live board generated from active master data** (Plant / Line / Process / Equipment) rather than
   a fixed layout.
7. **Equipment-level history and repeat-issue analytics** must stay possible (e.g. optional
   `equipment_id` on an ANDON; E2 "same issue repeats per shift" could count per equipment — see OBD-15).

Scope note: equipment master data is **optional for the first pilot**. The Reaction Rule milestone
must work with Line / Process only and must not wait for complete equipment data.
