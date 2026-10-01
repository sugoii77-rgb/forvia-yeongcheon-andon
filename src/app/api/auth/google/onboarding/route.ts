import { finishGoogleOnboarding, googleHandle, onboardingInfo } from '@/lib/server/googleAuth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  return googleHandle(async () => Response.json(await onboardingInfo(req), {headers:{'Cache-Control':'no-store'}}));
}
export async function POST(req: Request) {
  return googleHandle(async () => finishGoogleOnboarding(req,await req.json()));
}
