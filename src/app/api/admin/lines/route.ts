import { OWNERSHIP_VIEW_ROLES } from "@/lib/domain";
import { getSessionUser } from "@/lib/server/auth";
import { AndonError } from "@/lib/server/errors";
import { handle } from "@/lib/server/http";
import { listLineOwnership } from "@/lib/server/lineAssignments";

// Line ownership master (Supervisor / GAP leader per shift). Login required AND an ownership-view role
// (assigned by an administrator; self-registered RESPONDER accounts are refused). Names only — no
// contact fields are read or returned.
export async function GET(req: Request) {
  return handle("GET /api/admin/lines", async () => {
    const user = await getSessionUser(req);
    if (!user) throw new AndonError(401, "로그인이 필요합니다.", "AUTH_REQUIRED");
    if (!user.active || !OWNERSHIP_VIEW_ROLES.includes(user.role)) {
      throw new AndonError(403, "기준정보 조회 권한이 없습니다.", "ROLE_NOT_ALLOWED");
    }
    return Response.json(await listLineOwnership(), { headers: { "Cache-Control": "no-store" } });
  });
}
