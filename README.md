# Digital ANDON — FORVIA Yeongcheon Plant (prototype)

Create ANDON → live dashboard turns RED → responder ACKNOWLEDGE (YELLOW) → ACTION → CLOSE (GREEN),
with complete, append-only history and basic statistics.

**Full documentation, architecture and handover notes: [PROJECT.md](PROJECT.md).**

## Quick start

Requires **Node.js 24** (`node --version`). Install in a short path (e.g. `C:\andon`).

```bash
npm install
cp .env.example .env          # Windows: copy .env.example .env
npm run seed -- --reset       # optional demo data
npm run serve                 # http://localhost:<PORT from .env>  (builds if needed, auto-restarts)
```

| Screen | URL |
|---|---|
| Operator ANDON call (tablet/phone) | `/operator` |
| Live plant map — where is the abnormality (large monitor, 1920 × 1080) | `/dashboard` |
| Previous card dashboard | `/dashboard/list` |
| Responder inbox / event (phone, notification link) — **login required to act** | `/respond`, `/respond/<ANDON-ID>` |
| Register / login / my info | `/register`, `/login`, `/me` |
| History & analytics | `/history` |
| Line ownership master (GAP leader / supervisor / engineer / plant manager login) | `/admin/lines` |
| A/B shift schedule + anchor (view: same roles; change: supervisor / plant manager) | `/admin/shifts` |
| Health check | `/api/health` |

**Cloud demo (Vercel + Turso + Vercel Blob):** https://forvia-yeongcheon-andon.vercel.app — deploys automatically on push to `main`.
Limits and operation: PROJECT.md §9 "Vercel deployment" and §12.

## Useful commands

| Command | Purpose |
|---|---|
| `npm run serve` / `npm run status` / `npm run stop` | run under the supervisor / check / stop (see RUNBOOK.md) |
| `npm run dev` | development server with hot reload |
| `npm run typecheck` / `npm run lint` | static checks |
| `npm run test:golden` | end-to-end Golden Path test against a running server (`BASE_URL=http://localhost:3000`) |
| `npm run test:reliability` | photo-failure tests (ANDON must still be created) |
| `npm run test:routing` | routing / responder identity / device audit tests |
| `npm run test:auth` | registration / login / session / authorization tests |
| `npm run test:google` | Google OIDC tests with a fake Google (isolated DB under `work/`, see PROJECT.md §10) |
| `vercel env run -e production -- npm run db:migrate` | migrate the Vercel (Turso) database — before pushing a schema change |
| `npm run import:uap -- <workbook.xlsx> [--dry-run]` | ADMIN: import line ownership (Supervisor / GAP leader A / B) from the plant workbook (kept outside the repo) |
| `npm run test:display` | plant-map display tests (`-- --http` optional) |
| `npm run test:shifts` | A/B shift schedule tests (fixed timestamps; `-- --http` optional) |
| `npm run test:lines` | line master / ownership tests (`-- --http`, `-- --workbook <file>` optional) |
| `npm run masterdata -- list` | ADMIN: show / change users (role, department, active, password reset), routing rules (RUNBOOK.md §7) |
| `npm run backup` | online DB backup → `data/backups/` |
| `npm run seed -- --reset` | reset to demo data (stop server first; old DB is backed up) |

Operators call ANDON without login. Responders log in locally or — once configured (RUNBOOK.md §9) — with Google. Responders **register** (`/register`: name, e-mail, department ME / MT / UAP / QC / PC&L) and become RESPONDER of that department automatically; other roles are set by an administrator. API tests register throw-away `*@andon.test` accounts and must run on the server PC, one at a time.

All runtime data lives in `data/` (SQLite DB, photos, logs). Operations and recovery: **[RUNBOOK.md](RUNBOOK.md)**. Auto-start at boot: `scripts/windows/install-autostart.ps1 -AtStartup`.
