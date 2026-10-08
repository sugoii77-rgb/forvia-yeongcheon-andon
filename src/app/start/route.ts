import { getSessionUser } from "@/lib/server/auth";
import { CALL_ROLES } from "@/lib/domain";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start page of the home-screen icon (web app manifest start_url): GAP leaders / supervisors straight to
// the call screen, other logged-in users to their department's ANDONs, everybody else to the menu.
export async function GET(req: Request) {
  const user = await getSessionUser(req).catch(() => null);
  const to = user?.active ? (CALL_ROLES.includes(user.role) ? "/operator" : "/respond") : "/";
  return new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store" } });
}
