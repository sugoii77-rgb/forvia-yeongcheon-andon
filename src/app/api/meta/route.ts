import { getMasterData } from "@/lib/server/andonService";
import { getSessionUser, requireSignedIn } from "@/lib/server/auth";
import { handle } from "@/lib/server/http";

// Signed-in users only (2026-10-19). While self-registration is open (test servers) the register /
// onboarding pages need the department list before there is a session.
export async function GET(req: Request) {
  return handle("GET /api/meta", async () => {
    const meta = await getMasterData();
    if (!meta.selfRegistration || (await getSessionUser(req))) return Response.json(meta);
    await requireSignedIn(req);
    return Response.json(meta);
  });
}
