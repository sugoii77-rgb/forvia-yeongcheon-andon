import { assertSameOrigin } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";
import { sendPushTest } from "@/lib/server/webPush";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle("POST /api/notify/push/test", async () => {
    assertSameOrigin(req);
    return Response.json({ ok: true, ...(await sendPushTest(req)) });
  });
}
