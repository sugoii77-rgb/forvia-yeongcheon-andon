import { completeGoogleCallback, googleHandle } from '@/lib/server/googleAuth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const response = await googleHandle(() => completeGoogleCallback(req));
  if (response.status < 400) return response;
  // Remove authorization code/state from the address bar even on denial or failure.
  return new Response(null,{status:303,headers:{Location:'/login?googleError=1','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
