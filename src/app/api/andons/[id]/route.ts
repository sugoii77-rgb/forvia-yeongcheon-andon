import { actionDepartmentCodes, getEvent, getNotifications, getTransitions, AndonError } from "@/lib/server/andonService";
import { eligibleResponders, eventResponsibility, validateResponder } from "@/lib/server/routingService";
import { allowedActions, type TransitionAction } from "@/lib/domain";
import { getSessionUser } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";

export async function GET(req: Request, ctx: RouteContext<"/api/andons/[id]">) {
  return handle("GET /api/andons/[id]", async () => {
    const { id } = await ctx.params;
    const event = await getEvent(id);
    if (!event) throw new AndonError(404, "ANDON을 찾을 수 없습니다.", "NOT_FOUND");
    const responsibility = await eventResponsibility(id);
    const eligible = await eligibleResponders(event.departments.map((d) => d.code));
    const viewer = await getSessionUser(req);
    // What the viewer may do now (server decides): e.g. on a QC event only UAP may CLOSE.
    const viewerActions: TransitionAction[] = [];
    if (viewer) {
      for (const a of allowedActions(event.status)) {
        try {
          await validateResponder({ userId: viewer.id }, await actionDepartmentCodes(id, event.departmentCode, a));
          viewerActions.push(a);
        } catch {
          /* not allowed */
        }
      }
    }
    return Response.json({
      event,
      transitions: await getTransitions(id),
      notifications: await getNotifications(id),
      // Routing and permission are decided by the server; the UI only displays them.
      responsibility,
      eligibleResponders: eligible,
      viewer: viewer && {
        user: viewer,
        canRespond: viewerActions.length > 0 || (viewer.canRespond && eligible.some((u) => u.id === viewer.id)),
        actions: viewerActions,
      },
      serverTime: new Date().toISOString(),
    });
  });
}
