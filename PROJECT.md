# PROJECT.md — Digital ANDON (FORVIA Yeongcheon Plant)

> **Source of truth for AI-to-AI and human handover.** Update this file at the end of every
> meaningful milestone (sections 11–16 at minimum).
>
> Last updated: **2026-10-01** · Milestone 1 (Golden Path) — **done and verified**

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
```

- **Single process, single DB file.** No Redis, no message broker, no separate DB server.
- **Real-time = polling** (dashboard 2 s, responder list 3 s, detail 5 s). Simple and survives
  server restarts/network hiccups without reconnection logic. SSE can be added later if needed.
- **History is append-only**: `andon_transition` rows can't be updated or deleted (SQLite triggers).
- **Notifications** go through a `NotificationProvider` interface. Currently `mock` (console +
  `notification_log` table). A Kakao provider can be dropped in without touching ANDON logic.
- Server-side clock is authoritative: API responses include `serverTime`; clients correct
  elapsed-time display for clock skew.

## 4. Technology stack

| Item | Choice | Why |
|---|---|---|
| Runtime | **Node.js 24** (≥ 22.13 works) | built-in SQLite + native TypeScript execution for scripts |
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
├─ .env.example            ← copy to .env
├─ scripts/
│  ├─ seed-demo.mts        ← demo data (npm run seed [-- --reset])
│  ├─ backup.ts            ← online DB backup (npm run backup)
│  └─ test-golden-path.ts  ← automated end-to-end API test (npm run test:golden)
├─ data/                   ← runtime data, git-ignored (created automatically)
│  ├─ andon.db             ← SQLite database (+ -wal / -shm files)
│  ├─ uploads/             ← ANDON photos
│  └─ backups/
└─ src/
   ├─ app/
   │  ├─ page.tsx                 home (links to 4 screens)
   │  ├─ operator/page.tsx        A. Operator ANDON call
   │  ├─ dashboard/page.tsx       B. Live dashboard (dark, large monitor)
   │  ├─ respond/page.tsx         C. Responder inbox (by department)
   │  ├─ respond/[id]/page.tsx    C. Event detail + ACK / ACTION / CLOSE (notification link target)
   │  ├─ history/page.tsx         D. History & analytics
   │  └─ api/
   │     ├─ andons/route.ts                 GET list (scope=board|active|all), POST create (multipart)
   │     ├─ andons/[id]/route.ts            GET detail + transitions + notification log
   │     ├─ andons/[id]/transition/route.ts POST {action, userName, comment}
   │     ├─ stats/route.ts                  GET ?days=N
   │     ├─ meta/route.ts                   GET master data
   │     ├─ photos/[file]/route.ts          GET photo
   │     └─ health/route.ts                 GET DB health (200 / 503)
   ├─ components/  TopBar, StatusBadge, ResponderPicker
   └─ lib/
      ├─ domain.ts         statuses, state machine rules, shared types (client + server)
      ├─ client.ts         browser helpers: api(), polling, formatting, local storage
      └─ server/
         ├─ db.ts          connection, schema, pragmas, master-data bootstrap
         ├─ masterData.ts  initial lines/processes/categories/departments/users
         ├─ andonService.ts  create / transition / queries / stats  (ALL state changes here)
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

**Tables** (`src/lib/server/db.ts`)

| Table | Purpose |
|---|---|
| `department` | QUALITY, PRODUCTION, MAINTENANCE, LOGISTICS, EHS |
| `category` | issue categories, each with `default_department` (routing) — configurable in DB |
| `line`, `process` | T-GDI 1, T-GDI 2, Muffler 1 and their processes |
| `app_user` | demo users; `role` RESPONDER/MANAGER; `kakao_id` reserved for Kakao |
| `andon_event` | **current state** of each ANDON + cached timestamps (`acknowledged_at`, `closed_at`, …) + `client_request_id` (UNIQUE, idempotency) |
| `andon_transition` | **append-only history**: event_id, action, from_status, to_status, user_name, comment, created_at |
| `notification_log` | every notification attempt: provider, recipient, SENT/FAILED, message, error |

- ANDON ID format: `AND-YYYYMMDD-NNN` (KST date, daily sequence).
- All timestamps stored as UTC ISO-8601 strings; displayed in Asia/Seoul.
- `PRAGMA user_version` = schema version (currently 1). Schema uses `CREATE … IF NOT EXISTS`;
  future changes need a small migration step keyed on `user_version`.
- Master data is inserted with `INSERT OR IGNORE` at start-up → DB edits are never overwritten.

**Future AI/rule monitoring readiness**: every state change is an immutable, timestamped row in
`andon_transition`, and `andon_event` has indexed `status` / `created_at`. Rules such as
"not acknowledged within 5 min" or "same defect 3×" are simple queries over these tables;
alerts can go through the same `NotificationProvider`.

## 7. Environment variables

See `.env.example`. Copy to `.env`. No secrets in source code.

| Variable | Default | Meaning |
|---|---|---|
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
npm run build && npm run start     # production mode (use this for demos / plant)
npm run dev                         # development mode with hot reload
```

- Default port 3000; change with `PORT=3100 npm run start` (PowerShell: `$env:PORT=3100; npm run start`).
- The server listens on all interfaces: phones/tablets use `http://<server-LAN-IP>:3000`.
- **Recovery:** stop and start the process; all state is in `data/`. Check `GET /api/health`.
- **Backup:** `npm run backup` (safe while running) → `data/backups/`.
- **Reset demo data:** stop the server, `npm run seed -- --reset` (previous DB is backed up first).

## 10. How to test

| Command | What it checks |
|---|---|
| `npm run typecheck` | Next typegen + `tsc --noEmit` |
| `npm run lint` | ESLint (Next config) |
| `npm run build` | production build |
| `npm run test:golden` | **end-to-end Golden Path against a running server** (set `BASE_URL`, default `http://localhost:3000`). 25 checks: create, idempotent duplicate, validation, board RED, photo, path traversal, notification log, illegal transitions (409), ACK/ACTION/CLOSE, full history, stats delta. Creates one `[TEST]` event. |

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

**Verified on 2026-10-01** (production build, Node 24.15, Windows 11):
`typecheck` ✔ · `lint` ✔ · `build` ✔ · `test:golden` 25/25 ✔ · UI golden path in browser
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
- Photos are stored at original size (≤ 10 MB, JPG/PNG/WEBP/HEIC). HEIC can't be displayed by most
  desktop browsers.
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

## 14. Pending tasks

**Milestone 2 — Notifications**
- [ ] `KakaoNotificationProvider` (credentials from `.env` only), register in `createProvider()`
- [ ] Map users → Kakao recipient (`app_user.kakao_id`)
- [ ] Retry policy for failed notifications (re-send from `notification_log` FAILED rows)

**Milestone 3 — Escalation / proactive (rule-based first, AI later)**
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
- [ ] PWA manifest / home-screen install; client-side photo resize
- [ ] Offline/failover (document only for now): local queue on operator device, standby server
      with periodic DB copy, Windows service / auto-restart (e.g. NSSM or pm2)
- [ ] Shift-based statistics, CSV export

## 15. Next recommended action

1. ~~Move the project to a permanent short path and put it under git~~ — done 2026-10-01 (`C:\andon`).
2. Run it on the intended demo/server PC, set `APP_BASE_URL` to that PC's LAN IP, and walk the
   Golden Path with real phones and the actual dashboard monitor.
3. Start Milestone 2: implement `KakaoNotificationProvider` against the existing interface.

## 16. Change log

| Date | Change |
|---|---|
| 2026-10-01 | Milestone 1: project scaffold (Next.js 16, node:sqlite), data model + state machine, operator / dashboard / responder / history screens, mock notification provider, demo seed, backup, health check, automated Golden Path test. Verified end-to-end (see §11). |
| 2026-10-01 | Moved project to `C:\andon` (permanent location), fresh `npm install`, git repository initialised. Re-verified typecheck / lint / build / `test:golden` at the new location. |
