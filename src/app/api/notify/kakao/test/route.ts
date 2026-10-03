import { assertSameOrigin } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";
import { sendKakaoTest } from "@/lib/server/kakaoNotify";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle("POST /api/notify/kakao/test", async () => {
    assertSameOrigin(req);
    await sendKakaoTest(req);
    return Response.json({ ok: true });
  });
}
