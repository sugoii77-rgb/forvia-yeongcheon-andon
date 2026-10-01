import { getEvent, getNotifications, getTransitions, AndonError } from "@/lib/server/andonService";
import { handle } from "@/lib/server/http";

export async function GET(_req: Request, ctx: RouteContext<"/api/andons/[id]">) {
  return handle("GET /api/andons/[id]", async () => {
    const { id } = await ctx.params;
    const event = getEvent(id);
    if (!event) throw new AndonError(404, "ANDON을 찾을 수 없습니다.", "NOT_FOUND");
    return Response.json({
      event,
      transitions: getTransitions(id),
      notifications: getNotifications(id),
      serverTime: new Date().toISOString(),
    });
  });
}
