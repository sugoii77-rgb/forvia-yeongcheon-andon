import { assertSameOrigin } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";
import { beginKakaoLink } from "@/lib/server/kakaoNotify";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle("POST /api/notify/kakao/start", async () => {
    assertSameOrigin(req);
    return Response.json(await beginKakaoLink(req), { headers: { "Cache-Control": "no-store" } });
  });
}
