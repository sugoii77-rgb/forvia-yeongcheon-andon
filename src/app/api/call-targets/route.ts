import { getSessionUser } from "@/lib/server/auth";
import { AndonError, callTargets } from "@/lib/server/andonService";
import { db } from "@/lib/server/db";
import { effectiveDepartment } from "@/lib/server/routingService";
import { CALL_SITUATIONS } from "@/lib/server/masterData";
import { handle } from "@/lib/server/http";
import { CALL_ROLES } from "@/lib/domain";

// Departments a GAP leader can call and their people (names + role only). Callers only — the list of
// names is never public.
export async function GET(req: Request) {
  return handle("GET /api/call-targets", async () => {
    const user = await getSessionUser(req);
    if (!user) throw new AndonError(401, "로그인이 필요합니다.", "AUTH_REQUIRED");
    if (!user.active || !CALL_ROLES.includes(user.role)) throw new AndonError(403, "ANDON 호출은 GAP 리더·감독자만 할 수 있습니다.", "ROLE_NOT_ALLOWED");
    // Suggested department per issue category (current department code; the GAP leader can change it).
    const categoryDefaults: Record<string, string> = {};
    for (const c of await db.all("SELECT code, default_department FROM category WHERE active = 1")) {
      categoryDefaults[c.code as string] = await effectiveDepartment(c.default_department as string);
    }
    const line = new URL(req.url).searchParams.get("line") ?? undefined;
    return Response.json({ departments: await callTargets(line), categoryDefaults, situations: CALL_SITUATIONS }, { headers: { "Cache-Control": "no-store" } });
  });
}
