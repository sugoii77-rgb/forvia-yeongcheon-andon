import { getSessionUser } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";

// Current user resolved on the server from the session (department / role / active from the DB).
export async function GET(req: Request) {
  return handle("GET /api/auth/me", async () => Response.json({ user: await getSessionUser(req) }));
}
