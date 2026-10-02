import { OWNERSHIP_VIEW_ROLES, SHIFT_ANCHOR_EDIT_ROLES, type PublicUser, type ShiftScheduleView } from "@/lib/domain";
import { assertSameOrigin, getSessionUser } from "@/lib/server/auth";
import { AndonError } from "@/lib/server/errors";
import { handle, requestAudit } from "@/lib/server/http";
import { currentShift, getShiftConfig, listShiftAudit, setShiftAnchor } from "@/lib/server/shiftService";

// A/B shift schedule administration. Login required: view = GAP_LEADER / SUPERVISOR / ENGINEER /
// PLANT_MANAGER; change the anchor = SUPERVISOR / PLANT_MANAGER. Every change is audited.
async function requireRole(req: Request, roles: readonly string[]): Promise<PublicUser> {
  const user = await getSessionUser(req);
  if (!user) throw new AndonError(401, "로그인이 필요합니다.", "AUTH_REQUIRED");
  if (!user.active || !roles.includes(user.role)) throw new AndonError(403, "근무조 기준정보 권한이 없습니다.", "ROLE_NOT_ALLOWED");
  return user;
}

async function view(user: PublicUser): Promise<ShiftScheduleView> {
  const c = await getShiftConfig();
  return {
    rule: c.rule,
    anchor: c.anchor,
    updatedAt: c.updatedAt,
    updatedBy: c.updatedBy,
    now: await currentShift(),
    audit: await listShiftAudit(20),
    canEdit: SHIFT_ANCHOR_EDIT_ROLES.includes(user.role),
  };
}

export async function GET(req: Request) {
  return handle("GET /api/admin/shift-schedule", async () => {
    const user = await requireRole(req, OWNERSHIP_VIEW_ROLES);
    return Response.json(await view(user), { headers: { "Cache-Control": "no-store" } });
  });
}

// JSON body: { anchorWeekMonday: "YYYY-MM-DD" (a Monday), anchorDayTeam: "A" | "B" }
export async function PUT(req: Request) {
  return handle("PUT /api/admin/shift-schedule", async () => {
    assertSameOrigin(req);
    const user = await requireRole(req, SHIFT_ANCHOR_EDIT_ROLES);
    const body = await req.json().catch(() => null);
    if (!body || typeof body.anchorWeekMonday !== "string" || typeof body.anchorDayTeam !== "string") {
      throw new AndonError(400, "기준 주(월요일)와 주간 근무조(A/B)를 입력하세요.", "SHIFT_ANCHOR_INVALID");
    }
    const audit = requestAudit(req);
    await setShiftAnchor(
      { anchorWeekMonday: body.anchorWeekMonday.trim(), anchorDayTeam: body.anchorDayTeam.trim().toUpperCase() as "A" | "B" },
      { userId: user.id, name: user.name, source: "WEB", clientIp: audit.clientIp, userAgent: audit.userAgent },
    );
    return Response.json(await view(user), { headers: { "Cache-Control": "no-store" } });
  });
}
