import { db } from "@/lib/server/db";

// For monitoring / quick recovery checks: returns 200 only if the database answers.
// `db` is the local file path or "turso <host>" — never credentials.
export async function GET() {
  try {
    const info = await db.info();
    // On Vercel (public internet) only "ok" — the DB host and the event count are not for strangers.
    // SELECT 1 still proves the database answers, without reading every event (Turso rows-read quota).
    if (process.env.VERCEL) {
      await db.get("SELECT 1");
      return Response.json({ ok: true, time: new Date().toISOString() });
    }
    const r = (await db.get("SELECT COUNT(*) AS n FROM andon_event")) as { n: number };
    return Response.json({ ok: true, db: info.label, backend: info.kind, events: r.n, time: new Date().toISOString() });
  } catch (err) {
    console.error("[health] DB check failed", err);
    return Response.json({ ok: false, error: "database unavailable" }, { status: 503 });
  }
}
