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
npm run build
npm run start                 # http://localhost:3000
```

| Screen | URL |
|---|---|
| Operator ANDON call (tablet/phone) | `/operator` |
| Live dashboard (large monitor) | `/dashboard` |
| Responder inbox / event (phone, notification link) | `/respond`, `/respond/<ANDON-ID>` |
| History & analytics | `/history` |
| Health check | `/api/health` |

## Useful commands

| Command | Purpose |
|---|---|
| `npm run dev` | development server with hot reload |
| `npm run typecheck` / `npm run lint` | static checks |
| `npm run test:golden` | end-to-end Golden Path test against a running server (`BASE_URL=http://localhost:3000`) |
| `npm run backup` | online DB backup → `data/backups/` |
| `npm run seed -- --reset` | reset to demo data (stop server first; old DB is backed up) |

All runtime data lives in `data/` (SQLite DB + photos). To recover: restart the process.
