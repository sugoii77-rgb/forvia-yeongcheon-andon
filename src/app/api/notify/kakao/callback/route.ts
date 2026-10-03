import { AndonError } from "@/lib/server/errors";
import { completeKakaoLink } from "@/lib/server/kakaoNotify";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Always a 303 back to /me, so the authorization code / state never stay in the address bar.
export async function GET(req: Request) {
  let result = "linked";
  try {
    await completeKakaoLink(req);
  } catch (err) {
    if (!(err instanceof AndonError)) console.error("[kakao] link callback failed", err);
    result = err instanceof AndonError ? err.code : "SERVER_ERROR";
  }
  const to = result === "linked" ? "/me?kakao=linked" : `/me?kakao=error&reason=${encodeURIComponent(result)}`;
  return new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
