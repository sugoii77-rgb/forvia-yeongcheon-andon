import { getEvent, getNotifications, getTransitions, AndonError } from "@/lib/server/andonService";
import { eligibleResponders, eventResponsibility } from "@/lib/server/routingService";
import { getSessionUser } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";

export async function GET(req: Request, ctx: RouteContext<"/api/andons/[id]">) {
  return handle("GET /api/andons/[id]", async () => {
    const { id } = await ctx.params;
    const event = getEvent(id);
    if (!event) throw new AndonError(404, "ANDON을 찾을 수 없습니다.", "NOT_FOUND");
    const responsibility = eventResponsibility(id);
    const eligible = eligibleResponders(event.departmentCode);
    const viewer = getSessionUser(req);
    return Response.json({
      event,
      transitions: getTransitions(id),
      notifications: getNotifications(id),
      // Routing and permission are decided by the server; the UI only displays them.
      responsibility,
      eligibleResponders: eligible,
      viewer: viewer && {
        user: viewer,
        canRespond: viewer.canRespond && eligible.some((u) => u.id === viewer.id),
      },
      serverTime: new Date().toISOString(),
    });
  });
}
