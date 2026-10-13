export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start page of icons installed before 2026-10-13 (old manifest start_url). Plant request 2026-10-13: the
// app opens on the main menu for everybody; the call screen is one tap away (ANDON 호출).
export async function GET() {
  return new Response(null, { status: 303, headers: { Location: "/", "Cache-Control": "no-store" } });
}
