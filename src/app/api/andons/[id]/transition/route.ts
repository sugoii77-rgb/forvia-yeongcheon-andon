import { transitionEvent, getTransitions, AndonError } from "@/lib/server/andonService";
import { TRANSITION_ACTIONS, type TransitionAction } from "@/lib/domain";
import { handle } from "@/lib/server/http";

// JSON body: { action: "ACKNOWLEDGE" | "ACTION" | "CLOSE", userName, comment? }
export async function POST(req: Request, ctx: RouteContext<"/api/andons/[id]/transition">) {
  return handle("POST /api/andons/[id]/transition", async () => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    if (!body || !TRANSITION_ACTIONS.includes(body.action)) {
      throw new AndonError(400, "요청 형식이 올바르지 않습니다.", "BAD_REQUEST");
    }
    const event = transitionEvent(id, {
      action: body.action as TransitionAction,
      userName: String(body.userName ?? ""),
      comment: body.comment == null ? undefined : String(body.comment),
    });
    console.info(`[andon] ${id} ${body.action} by ${body.userName} -> ${event.status}`);
    return Response.json({ event, transitions: getTransitions(id) });
  });
}
