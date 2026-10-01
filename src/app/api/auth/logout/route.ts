import { assertSameOrigin, clearSessionCookie, revokeSession } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";

export async function POST(req: Request) {
  return handle("POST /api/auth/logout", () => {
    assertSameOrigin(req);
    revokeSession(req);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie(req) } });
  });
}
