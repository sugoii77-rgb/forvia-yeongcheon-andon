import { assertSameOrigin } from "@/lib/server/auth";
import { AndonError } from "@/lib/server/errors";
import { handle, requestAudit } from "@/lib/server/http";
import { requestPasswordReset } from "@/lib/server/passwordReset";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// JSON { login } (사번 or e-mail) → 6-digit code to the employee's own KakaoTalk. Same answer for every login.
export async function POST(req: Request) {
  return handle("POST /api/auth/password-reset/request", async () => {
    assertSameOrigin(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new AndonError(400, "요청 형식이 올바르지 않습니다.", "BAD_REQUEST");
    const message = await requestPasswordReset(body.login, new URL(req.url).origin, requestAudit(req));
    return Response.json({ ok: true, message }, { headers: { "Cache-Control": "no-store" } });
  });
}
