import { getDb, DATABASE_PATH } from "@/lib/server/db";

// For monitoring / quick recovery checks: returns 200 only if the DB answers.
export async function GET() {
  try {
    const r = getDb().prepare("SELECT COUNT(*) AS n FROM andon_event").get() as { n: number };
    return Response.json({ ok: true, db: DATABASE_PATH, events: r.n, time: new Date().toISOString() });
  } catch (err) {
    console.error("[health] DB check failed", err);
    return Response.json({ ok: false, error: String(err) }, { status: 503 });
  }
}
