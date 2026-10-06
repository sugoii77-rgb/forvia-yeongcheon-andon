import { assertSameOrigin, changePassword } from "@/lib/server/auth";
import { AndonError } from "@/lib/server/errors";
import { handle, requestAudit } from "@/lib/server/http";

// JSON body: { currentPassword, newPassword, newPasswordConfirm }. Own account only (from the session).
export async function POST(req: Request) {
  return handle("POST /api/auth/password", async () => {
    assertSameOrigin(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new AndonError(400, "요청 형식이 올바르지 않습니다.", "BAD_REQUEST");
    await changePassword(req, body, requestAudit(req));
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  });
}
