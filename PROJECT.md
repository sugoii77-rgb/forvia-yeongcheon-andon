# PROJECT.md — Digital ANDON (FORVIA Yeongcheon Plant)

> **Source of truth for AI-to-AI and human handover.** Update this file at the end of every
> meaningful milestone (sections 11–16 at minimum).
>
> Last updated: **2026-10-01** · Milestone 1 — **done** · Milestone 2 — H1 + H2 done · 2A routing foundation — done · **2B registration & authentication — done**

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
- **Single process, single DB file.** No Redis, no message broker, no separate DB server.
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
| DB | **SQLite via built-in `node:sqlite`** | zero native build, zero DB server, one-file backup; easy for plant IT |
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
   │  ├─ me/page.tsx              내 정보 + 로그아웃
   │  └─ api/
   │     ├─ andons/route.ts                 GET list (scope=board|active|all, mine=1 = my department via session), POST create (multipart, no login)
   │     ├─ andons/[id]/route.ts            GET detail + transitions + notifications + responsibility + eligibleResponders + viewer.canRespond
   │     ├─ andons/[id]/transition/route.ts POST {action, comment} — responder = session user (401 without); header x-andon-device
   │     ├─ stats/route.ts                  GET ?days=N
   │     ├─ meta/route.ts                   GET master data
   │     ├─ photos/[file]/route.ts          GET photo
   │     ├─ health/route.ts                 GET DB health (200 / 503)
   │     └─ auth/register|login|logout|me   POST register / login / logout, GET current user
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

**Tables** (`src/lib/server/db.ts`, schema **v3**)

| Table | Purpose |
|---|---|
| `plant` | YC Yeongcheon (single plant for now) |
| `line` | T-GDI 1, T-GDI 2, Muffler 1 — `plant_code` → plant |
| `process` | processes per line |
| `department` | **ME, MT, UAP, QC, PCL** (active); `display_code` ("PC&L"), `sort_order`, `successor_code`. Pre-v3 codes QUALITY, PRODUCTION, MAINTENANCE, LOGISTICS, EHS stay as **inactive** rows with a successor |
| `category` | issue categories; `default_department` = routing when no rule matches |
| `role` | OPERATOR, RESPONDER, GAP_LEADER, SUPERVISOR, ENGINEER, PLANT_MANAGER; `can_respond`, `escalation_level` (prepared) |
| `app_user` | id, name (not unique), email (unique, normalized; NULL = no login), department_code → department, role → role, active, source (SEED / REGISTRATION / ADMIN), created_at. Never delete — deactivate |
| `user_identity` | how a person logs in: provider (LOCAL now; GOOGLE / KAKAO later), subject (LOCAL: e-mail), password_hash (scrypt, LOCAL only), last_login_at; unique (provider, subject) |
| `user_session` | server-side sessions: SHA-256 of the cookie token, user_id, expires_at, revoked_at, device / IP / user agent at login |
| `user_notification_channel` | **prepared, unused**: where a person receives messages (provider KAKAO / SMS / EMAIL, recipient_id, verified, active) — separate from login identity |
| `routing_rule` | category + line [+ process] → department override; `active`; unique per (category, line, process); trigger: process must belong to line |
| `andon_event` | **current state** + cached timestamps + `client_request_id` (UNIQUE, idempotency) + `department_code` and `routing_rule_id` (decided at creation, never re-routed) + `escalation_level` (prepared, always 0) |
| `andon_transition` | **append-only history** (UPDATE/DELETE blocked by triggers): action, from/to status, `user_name`, `user_id`, `user_department` + `user_role` (snapshot at the time of the action, v3), comment, created_at, `device_id`, `client_ip`, `user_agent` |
| `notification_log` | every notification attempt: provider, recipient, SENT/FAILED, message, error |
| `escalation_policy`, `escalation_step` | **prepared, inactive** escalation model (see below) |

- ANDON ID format: `AND-YYYYMMDD-NNN` (KST date, daily sequence).
- All timestamps stored as UTC ISO-8601 strings; displayed in Asia/Seoul.
- **Migrations:** `PRAGMA user_version` = applied schema version (now **3**). `db.ts` runs pending
  migrations in order, each in its own transaction, after writing
  `data/backups/andon-pre-migration-v<from>-to-v<to>-<time>.db`. A DB newer than the app is refused.
  Never edit a released migration; add a new one.
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
- **Future identity providers**: a Google or Kakao login adds a `user_identity` row
  (provider = GOOGLE / KAKAO, subject = provider user id) for the same `app_user`. Routing and
  eligibility only use `app_user` (department, role, active), never the provider.
- **Notification identity is separate**: `user_notification_channel` (prepared) will hold e.g. the
  KakaoTalk recipient id. A Google e-mail is never assumed to be a Kakao recipient.

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
| `COOKIE_SECURE` | `auto` | `auto` = Secure flag only on HTTPS; `true` / `false` to force |
| `PORT` | `3000` | server port used by `npm run serve` (this dev PC uses `3100`: port 3000 is taken by another app) |
| `HOST` | (all interfaces) | optional bind address for `npm run serve` |
| `DATABASE_PATH` | `./data/andon.db` | SQLite file |
| `UPLOAD_DIR` | `./data/uploads` | photo folder |
| `APP_BASE_URL` | `http://localhost:3000` | base for links in notifications — **set to the LAN address** |
| `NOTIFICATION_PROVIDER` | `mock` | `mock` only for now; `kakao` planned |
| `KAKAO_*` | — | placeholders for the future Kakao provider (keep only in `.env`) |

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

**Verified on 2026-10-01** (production build, Node 24.15, Windows 11):
`typecheck` ✔ · `lint` ✔ · `build` ✔ · `test:golden` 26/26 ✔ (earlier reports said "25/25" — that was a miscount; the test has 26 checks) · UI golden path in browser
(operator at 375 px → dashboard RED → responder ACK → dashboard YELLOW without reload → ACTION →
CLOSE → dashboard GREEN, counters updated) ✔ · append-only triggers block UPDATE/DELETE ✔ ·
server stopped: dashboard shows disconnect banner, operator sees "호출 실패" ✔ · server restarted:
data intact, operator retry succeeds ✔ · backup script ✔.

## 12. Known issues / limitations

- **No authentication.** Responder picks a name from a list (stored per device). Anyone on the
  LAN can act. Acceptable for the prototype; needs SSO/AD or PIN before production use.
- **Notifications are mock only** (console + `notification_log`). Link base URL comes from
  `APP_BASE_URL` — must be set to the LAN address for phones.
- **Transition retry after a lost response**: if ACK succeeded but the response was lost, pressing
  ACK again returns a 409 message ("현재 상태에서는…") — data is correct, the screen refreshes itself.
- **No sound** on the dashboard for new RED events yet (browsers block autoplay without interaction).
- Photos are resized on the device; photos sent by other clients (API) are stored as received
  (≤ 10 MB, JPG/PNG/WEBP/HEIC). File content is not verified against the declared type.
- **Authentication is a prototype (LOCAL accounts), not enterprise SSO.** Limitations:
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
- [ ] Google login (`user_identity` provider GOOGLE) / Kakao login (provider KAKAO) — not started
- [ ] **CANCEL / false-call outcome** (pending requirement): new terminal status or action with a reason,
      excluded from KPIs; must use the same responder validation and device audit
- [ ] Small fixes: `limit` validation (500 on `?limit=abc`), `nosniff` + `poweredByHeader: false`,
      notification try/catch, schema `user_version` check, Node engines ≥ 22.18, backup photos too

**Milestone 3 — Notifications (H3)**
- [ ] `KakaoNotificationProvider` (credentials from `.env` only), register in `createProvider()`
- [ ] Map users → Kakao recipient (`app_user.kakao_id`); correct `APP_BASE_URL` (LAN IP + port)
- [ ] Retry policy for failed notifications (re-send from `notification_log` FAILED rows)

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

1. ~~Move the project to a permanent short path and put it under git~~ — done 2026-10-01 (`C:\andon`).
2. Decide where the demo server runs; on that PC follow RUNBOOK.md §8 (first-time setup) and
   register auto-start with `-AtStartup`. Then reboot it once and confirm the system comes back alone.
3. Let the real responders register (QC, MT, UAP, PC&L, ME) and assign leader roles with
   `npm run masterdata`; confirm SAFETY → UAP and define ME routing. Then: test-data separation + CANCEL, then Milestone 3 (Kakao), then escalation. Walk the Golden Path with real phones and the actual dashboard monitor.

## 16. Change log

| Date | Change |
|---|---|
| 2026-10-01 | Milestone 1: project scaffold (Next.js 16, node:sqlite), data model + state machine, operator / dashboard / responder / history screens, mock notification provider, demo seed, backup, health check, automated Golden Path test. Verified end-to-end (see §11). |
| 2026-10-01 | Moved project to `C:\andon` (permanent location), fresh `npm install`, git repository initialised. Re-verified typecheck / lint / build / `test:golden` at the new location. |
| 2026-10-01 | Recovery: removed an accidental nested copy (`digital-andon/`) that broke typecheck/lint/build; tool scope made explicit (commit `a702b41`). |
| 2026-10-01 | Milestone 2 part 1 — H1: photo problems never block the ANDON call (server warning instead of 400; on-device resize to ≤1600 px JPEG; `test:reliability`). H2: `scripts/supervisor.ts` (`npm run serve/status/stop`), restart + watchdog + auto-rebuild + stale-process cleanup + daily logs, Windows auto-start scripts, RUNBOOK.md. Verified: typecheck/lint/build ✔, `test:golden` 26/26, `test:reliability` 6/6, browser: 12.2 MB 4000×3000 photo → 631 KB 1600×1200 JPEG; undecodable photo → note, call still possible; supervisor: crash → back in 2 s, stale server stopped, double start refused, failing health → restart after 3 checks, missing build → rebuilt (healthy 5 s after start), stop → port free. Auto-start task validated by dry run only (not registered). |
| 2026-10-01 | Milestone 2A — responsibility & routing foundation: schema v2 with migration runner + pre-migration backup; plant / role / routing_rule / escalation_policy / escalation_step tables; app_user with role FK (MANAGER → SUPERVISOR); deterministic routing (process rule > line rule > category default) stored per event; server-side responder validation; device id / IP / user agent on every history row; eligible-only responder picker; `npm run masterdata`; `npm run test:routing`. Verified: fresh DB + seed, live-DB copy v1→v2 (40 events / 136 history rows preserved), live DB migrated with backup; typecheck / lint / build ✔; test:routing 38/38, test:golden 26/26, test:reliability 6/6; mobile UI ACK shows device + IP + "Android · Chrome" in history. |
| 2026-10-01 | Milestone 2B — user registration & authentication: schema v3 (departments ME / MT / UAP / QC / PCL with old codes kept inactive + successor; app_user rebuilt with e-mail, non-unique name; user_identity, user_session, user_notification_channel; actor department / role on history rows); scrypt passwords; server-side sessions (HttpOnly, SameSite=Lax); /register, /login, /me; responder actions only as the logged-in user; masterdata CLI admin commands; tests use registered throw-away accounts. Migration verified on a copy and on the live DB: events 73 / history 239 / notifications 67 / users 10 unchanged, event-department and history checksums identical. Verified: typecheck / lint / build ✔; test:auth 42/42, test:routing 39/39, test:golden 26/26, test:reliability 6/6; browser (mobile): register → back to the event → ACK / ACTION / CLOSE as the logged-in QC user → timeline shows name, QC · 품질 · RESPONDER, device, IP, browser; QC user on an MT ANDON: no buttons + 403 from the API; logout. |
