import { transitionEvent, getTransitions, AndonError } from "@/lib/server/andonService";
import { assertSameOrigin, getSessionUser } from "@/lib/server/auth";
import { TRANSITION_ACTIONS, type TransitionAction } from "@/lib/domain";
import { handle, requestAudit } from "@/lib/server/http";
import { notifyAndonClosed } from "@/lib/server/notifications";
import { after } from "next/server";

// JSON body: { action: "ACKNOWLEDGE" | "ACTION" | "CLOSE", comment? }
// The responder is ALWAYS the logged-in user (session cookie). Identity in the body is never trusted:
// if a body names a different user the request is rejected.
// Header x-andon-device: browser device id (recorded in history).
export async function POST(req: Request, ctx: RouteContext<"/api/andons/[id]/transition">) {
  return handle("POST /api/andons/[id]/transition", async () => {
    assertSameOrigin(req);
    const { id } = await ctx.params;
    const user = await getSessionUser(req);
    if (!user) throw new AndonError(401, "로그인이 필요합니다.", "AUTH_REQUIRED");

    const body = await req.json().catch(() => null);
    if (!body || !TRANSITION_ACTIONS.includes(body.action)) {
      throw new AndonError(400, "요청 형식이 올바르지 않습니다.", "BAD_REQUEST");
    }
    const claimsOther =
      (body.userId != null && Number(body.userId) !== user.id) ||
      (body.userName != null && String(body.userName).trim() !== user.name);
    if (claimsOther) throw new AndonError(400, "담당자 정보가 로그인 사용자와 다릅니다.", "RESPONDER_MISMATCH");

    const audit = requestAudit(req);
    const event = await transitionEvent(id, {
      action: body.action as TransitionAction,
      userId: user.id,
      comment: body.comment == null ? undefined : String(body.comment),
      audit,
    });
    if (event.status === "CLOSED") after(() => notifyAndonClosed(event)); // completion notice (자재 결품)
    console.info(`[andon] ${id} ${body.action} by user #${user.id} (${user.departmentCode}) device ${audit.deviceId ?? "-"} ${audit.clientIp ?? ""} -> ${event.status}`);
    return Response.json({ event, transitions: await getTransitions(id) });
  });
}
