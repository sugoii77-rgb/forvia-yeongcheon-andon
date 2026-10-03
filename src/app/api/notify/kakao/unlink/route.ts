import { assertSameOrigin } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";
import { unlinkKakaoFor } from "@/lib/server/kakaoNotify";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle("POST /api/notify/kakao/unlink", async () => {
    assertSameOrigin(req);
    await unlinkKakaoFor(req);
    return Response.json({ ok: true });
  });
}
