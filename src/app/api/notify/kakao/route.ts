import { handle } from "@/lib/server/http";
import { kakaoStatusFor } from "@/lib/server/kakaoNotify";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Kakao notification status of the logged-in user (no tokens, no Kakao user id).
export async function GET(req: Request) {
  return handle("GET /api/notify/kakao", async () => Response.json(await kakaoStatusFor(req), { headers: { "Cache-Control": "no-store" } }));
}
