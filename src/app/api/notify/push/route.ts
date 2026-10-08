import { handle } from "@/lib/server/http";
import { pushStatusFor } from "@/lib/server/webPush";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Push status of the logged-in user: configured, VAPID public key, number of devices turned on.
export async function GET(req: Request) {
  return handle("GET /api/notify/push", async () => Response.json(await pushStatusFor(req), { headers: { "Cache-Control": "no-store" } }));
}
