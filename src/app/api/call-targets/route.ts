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
    // The caller's own lines (active Supervisor / GAP leader assignment) — shown first on the call screen.
    const myLines = (
      await db.all(
        `SELECT DISTINCT a.line_code, l.sort_order FROM line_assignment a JOIN line l ON l.code = a.line_code
         WHERE a.user_id = ? AND a.active = 1 AND l.active = 1 AND (a.effective_to IS NULL OR a.effective_to > ?)
         ORDER BY l.sort_order`,
        user.id,
        new Date().toISOString(),
      )
    ).map((r) => r.line_code as string);
    const line = new URL(req.url).searchParams.get("line") ?? undefined;
    return Response.json({ departments: await callTargets(line), categoryDefaults, situations: CALL_SITUATIONS, myLines }, { headers: { "Cache-Control": "no-store" } });
  });
}
