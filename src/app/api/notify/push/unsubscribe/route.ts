import { assertSameOrigin } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";
import { unsubscribeFor } from "@/lib/server/webPush";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle("POST /api/notify/push/unsubscribe", async () => {
    assertSameOrigin(req);
    const body = (await req.json().catch(() => ({}))) as { endpoint?: unknown };
    await unsubscribeFor(req, body.endpoint);
    return Response.json({ ok: true });
  });
}
