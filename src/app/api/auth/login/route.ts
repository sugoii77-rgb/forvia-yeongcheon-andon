import { assertSameOrigin, authenticate, createSession, revokeSession, sessionCookie } from "@/lib/server/auth";
import { AndonError } from "@/lib/server/andonService";
import { handle, requestAudit } from "@/lib/server/http";

// JSON body: { email, password }. Always issues a NEW session token; any session cookie sent with the
// request is revoked first (no session fixation).
export async function POST(req: Request) {
  return handle("POST /api/auth/login", async () => {
    assertSameOrigin(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new AndonError(400, "요청 형식이 올바르지 않습니다.", "BAD_REQUEST");
    const audit = requestAudit(req);
    const user = await authenticate(body.email, body.password, audit);
    revokeSession(req);
    const { token, expiresAt } = createSession(user.id, audit);
    console.info(`[auth] login user #${user.id}`);
    return Response.json({ user }, { headers: { "Set-Cookie": sessionCookie(req, token, expiresAt) } });
  });
}
