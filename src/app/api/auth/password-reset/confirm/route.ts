import { assertSameOrigin } from "@/lib/server/auth";
import { AndonError } from "@/lib/server/errors";
import { handle, requestAudit } from "@/lib/server/http";
import { confirmPasswordReset } from "@/lib/server/passwordReset";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// JSON { login, code, newPassword, newPasswordConfirm } → new password; all sessions of the employee end.
export async function POST(req: Request) {
  return handle("POST /api/auth/password-reset/confirm", async () => {
    assertSameOrigin(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new AndonError(400, "요청 형식이 올바르지 않습니다.", "BAD_REQUEST");
    await confirmPasswordReset(body, requestAudit(req));
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  });
}
