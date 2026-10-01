import { getStats } from "@/lib/server/andonService";
import { handle } from "@/lib/server/http";

// ?days=7 (default) — range ends now.
export async function GET(req: Request) {
  return handle("GET /api/stats", async () => {
    const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days") ?? 7) || 7, 1), 365);
    const to = new Date(Date.now() + 1000);
    const from = new Date(to.getTime() - days * 86400_000);
    return Response.json(await getStats(from.toISOString(), to.toISOString()));
  });
}
