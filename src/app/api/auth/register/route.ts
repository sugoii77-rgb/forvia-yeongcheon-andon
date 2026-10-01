import { assertSameOrigin, createSession, registerUser, sessionCookie } from "@/lib/server/auth";
import { AndonError } from "@/lib/server/andonService";
import { handle, requestAudit } from "@/lib/server/http";

// JSON body: { name, email, department, password, passwordConfirm }
// Creates an active RESPONDER of the chosen department (role cannot be chosen) and logs the user in.
export async function POST(req: Request) {
  return handle("POST /api/auth/register", async () => {
    assertSameOrigin(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new AndonError(400, "요청 형식이 올바르지 않습니다.", "BAD_REQUEST");
    const user = await registerUser({
      name: body.name,
      email: body.email,
      department: body.department,
      password: body.password,
      passwordConfirm: body.passwordConfirm,
    });
    const { token, expiresAt } = await createSession(user.id, requestAudit(req));
    return Response.json({ user }, { status: 201, headers: { "Set-Cookie": sessionCookie(req, token, expiresAt) } });
  });
}
