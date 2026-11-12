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
    if (!user.active || !CALL_ROLES.includes(user.role)) throw new AndonError(403, "ANDON 호출은 GAP 리더·슈퍼만 할 수 있습니다.", "ROLE_NOT_ALLOWED");
    // Suggested department per issue category (current department code; the GAP leader can change it).
    const categoryDefaults: Record<string, string> = {};
    for (const c of await db.all("SELECT code, default_department FROM category WHERE active = 1")) {
      categoryDefaults[c.code as string] = await effectiveDepartment(c.default_department as string);
    }
    // The caller's own lines (active Supervisor / GAP leader assignment) — shown first on the call screen.
    // A GAP leader also gets every other line of their supervisor: they often cover those lines in a pinch
    // (plant request 2026-11-12).
    const myLines = (
      await db.all(
        `WITH cur AS (SELECT line_code, user_id, assignment_role FROM line_assignment
                       WHERE active = 1 AND (effective_to IS NULL OR effective_to > ?1))
         SELECT l.code AS line_code FROM line l
          WHERE l.active = 1 AND (
                l.code IN (SELECT line_code FROM cur WHERE user_id = ?2)
             OR l.code IN (SELECT s2.line_code FROM cur g
                             JOIN cur s1 ON s1.line_code = g.line_code AND s1.assignment_role = 'SUPERVISOR'
                             JOIN cur s2 ON s2.user_id = s1.user_id AND s2.assignment_role = 'SUPERVISOR'
                            WHERE g.user_id = ?2 AND g.assignment_role = 'GAP_LEADER'))
          ORDER BY l.sort_order`,
        new Date().toISOString(),
        user.id,
      )
    ).map((r) => r.line_code as string);
    const line = new URL(req.url).searchParams.get("line") ?? undefined;
    return Response.json({ departments: await callTargets(line), categoryDefaults, situations: CALL_SITUATIONS.filter((s) => !s.retired), myLines }, { headers: { "Cache-Control": "no-store" } });
  });
}
