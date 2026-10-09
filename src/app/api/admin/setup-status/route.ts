import { canViewSetupStatus } from "@/lib/domain";
import { getSessionUser } from "@/lib/server/auth";
import { AndonError } from "@/lib/server/errors";
import { handle } from "@/lib/server/http";
import { listSetupStatus } from "@/lib/server/setupStatus";
export const dynamic = "force-dynamic";

// Login / KakaoTalk / phone-push setup of every account. GL · SV · engineer · plant manager and every 팀장.
export async function GET(req: Request) {
  return handle("GET /api/admin/setup-status", async () => {
    const user = await getSessionUser(req);
    if (!user) throw new AndonError(401, "로그인이 필요합니다.", "AUTH_REQUIRED");
    if (!canViewSetupStatus(user)) throw new AndonError(403, "설정 현황 조회 권한이 없습니다.", "ROLE_NOT_ALLOWED");
    return Response.json({ people: await listSetupStatus(), at: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  });
}
