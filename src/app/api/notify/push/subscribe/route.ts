import { assertSameOrigin } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";
import { subscribeFor } from "@/lib/server/webPush";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Body: { subscription: PushSubscription.toJSON(), oldEndpoint?: string } (oldEndpoint from the service worker
// when the browser rotated the subscription).
export async function POST(req: Request) {
  return handle("POST /api/notify/push/subscribe", async () => {
    assertSameOrigin(req);
    const body = (await req.json().catch(() => ({}))) as { subscription?: unknown; oldEndpoint?: unknown };
    await subscribeFor(req, body.subscription, typeof body.oldEndpoint === "string" ? body.oldEndpoint : undefined);
    return Response.json({ ok: true });
  });
}
