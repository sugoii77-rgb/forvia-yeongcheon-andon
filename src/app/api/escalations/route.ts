import { runEscalations } from "@/lib/server/escalation";
import { handle } from "@/lib/server/http";
import { AndonError } from "@/lib/server/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Escalation check for an external scheduler (e.g. Vercel Cron / GitHub Actions) — only with
// "Authorization: Bearer <CRON_SECRET>". The shop-floor board also triggers it while it is open.
export async function GET(req: Request) {
  return handle("GET /api/escalations", async () => {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
      // a missing / changed CRON_SECRET stops the escalation check silently otherwise (2026-11-10: 401 every minute)
      console.warn(`[escalation] unauthorized call${secret ? "" : " — CRON_SECRET is not set"}`);
      throw new AndonError(401, "unauthorized", "AUTH_REQUIRED");
    }
    const escalated = await runEscalations();
    return Response.json({ escalated: escalated.length });
  });
}
