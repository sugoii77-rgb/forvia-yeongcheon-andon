import { ImageResponse } from "next/og";
import { appIcon } from "@/lib/appIcon";

// PNG icons for the web app manifest (Android "홈 화면에 추가" / install). Built once at build time.
const ICONS: Record<string, { size: number; pad: number }> = {
  "icon-192.png": { size: 192, pad: 0.06 },
  "icon-512.png": { size: 512, pad: 0.06 },
  "maskable-512.png": { size: 512, pad: 0.14 },
};

export const dynamic = "force-static";
export function generateStaticParams() {
  return Object.keys(ICONS).map((name) => ({ name }));
}

export async function GET(_req: Request, ctx: RouteContext<"/pwa/[name]">) {
  const icon = ICONS[(await ctx.params).name];
  if (!icon) return new Response("Not found", { status: 404 });
  return new ImageResponse(appIcon(icon.size, icon.pad), { width: icon.size, height: icon.size });
}
