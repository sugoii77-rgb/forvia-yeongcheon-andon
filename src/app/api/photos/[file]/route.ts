import { readPhoto, CONTENT_TYPE } from "@/lib/server/photos";
import { getSessionUser } from "@/lib/server/auth";

export async function GET(req: Request, ctx: RouteContext<"/api/photos/[file]">) {
  const viewer = await getSessionUser(req).catch(() => null);
  if (!viewer?.active) return new Response("로그인이 필요합니다.", { status: 401 }); // signed-in users only (2026-10-19)
  const { file } = await ctx.params;
  const data = await readPhoto(file);
  if (!data) return new Response("Not found", { status: 404 });
  const ext = file.split(".").pop()!;
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": CONTENT_TYPE[ext] ?? "application/octet-stream",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
