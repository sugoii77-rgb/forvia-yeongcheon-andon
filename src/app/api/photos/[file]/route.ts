import { readPhoto, CONTENT_TYPE } from "@/lib/server/photos";

export async function GET(_req: Request, ctx: RouteContext<"/api/photos/[file]">) {
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
