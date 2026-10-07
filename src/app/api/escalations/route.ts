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
    if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) throw new AndonError(401, "unauthorized", "AUTH_REQUIRED");
    const escalated = await runEscalations();
    return Response.json({ escalated: escalated.length });
  });
}
