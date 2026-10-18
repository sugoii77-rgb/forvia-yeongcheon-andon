import { db } from "@/lib/server/db";

// For monitoring / quick recovery checks: returns 200 only if the database answers.
// `db` is the local file path or "turso <host>" — never credentials.
export async function GET() {
  try {
    const info = await db.info();
    const r = (await db.get("SELECT COUNT(*) AS n FROM andon_event")) as { n: number };
    // On Vercel (public internet) only "ok" — the DB host and the event count are not for strangers.
    if (process.env.VERCEL) return Response.json({ ok: true, time: new Date().toISOString() });
    return Response.json({ ok: true, db: info.label, backend: info.kind, events: r.n, time: new Date().toISOString() });
  } catch (err) {
    console.error("[health] DB check failed", err);
    return Response.json({ ok: false, error: "database unavailable" }, { status: 503 });
  }
}
