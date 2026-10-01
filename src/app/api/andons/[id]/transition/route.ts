import { transitionEvent, getTransitions, AndonError } from "@/lib/server/andonService";
import { TRANSITION_ACTIONS, type TransitionAction } from "@/lib/domain";
import { handle, requestAudit } from "@/lib/server/http";

// JSON body: { action: "ACKNOWLEDGE" | "ACTION" | "CLOSE", userId (preferred) | userName, comment? }
// Header x-andon-device: browser device id (recorded in history).
export async function POST(req: Request, ctx: RouteContext<"/api/andons/[id]/transition">) {
  return handle("POST /api/andons/[id]/transition", async () => {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    if (!body || !TRANSITION_ACTIONS.includes(body.action)) {
      throw new AndonError(400, "요청 형식이 올바르지 않습니다.", "BAD_REQUEST");
    }
    const userId = body.userId == null || body.userId === "" ? null : Number(body.userId);
    if (userId !== null && !Number.isInteger(userId)) {
      throw new AndonError(400, "등록되지 않은 담당자입니다.", "UNKNOWN_RESPONDER");
    }
    const audit = requestAudit(req);
    const event = transitionEvent(id, {
      action: body.action as TransitionAction,
      userId,
      userName: body.userName == null ? null : String(body.userName),
      comment: body.comment == null ? undefined : String(body.comment),
      audit,
    });
    const last = getTransitions(id).at(-1);
    console.info(`[andon] ${id} ${body.action} by ${last?.userName} (#${last?.userId}) device ${audit.deviceId ?? "-"} ${audit.clientIp ?? ""} -> ${event.status}`);
    return Response.json({ event, transitions: getTransitions(id) });
  });
}
