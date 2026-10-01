import { beginGoogle, googleConfigured, googleHandle } from '@/lib/server/googleAuth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** { configured } only — lets the login page hide the Google button when Google is not set up. */
export async function GET() {
  return Response.json({ configured: googleConfigured() }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  return googleHandle(async () => beginGoogle(req, await req.json()));
}
