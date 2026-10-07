import { getSessionUser } from "@/lib/server/auth";
import { AndonError } from "@/lib/server/errors";
import { historyCsv } from "@/lib/server/historyExport";
import { handle } from "@/lib/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/history/export?from=YYYY-MM-DD&to=YYYY-MM-DD  (Korea dates, both inclusive) → CSV download.
// Logged-in users only (the file contains the names of the people who acted).
export async function GET(req: Request) {
  return handle("GET /api/history/export", async () => {
    const user = await getSessionUser(req);
    if (!user || !user.active) throw new AndonError(401, "로그인이 필요합니다.", "AUTH_REQUIRED");
    const q = new URL(req.url).searchParams;
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const from = q.get("from") ?? "";
    const to = q.get("to") ?? "";
    if (!day.test(from) || !day.test(to) || from > to) throw new AndonError(400, "기간을 YYYY-MM-DD 형식으로 입력하세요.", "BAD_RANGE");
    const fromIso = new Date(`${from}T00:00:00+09:00`).toISOString();
    const toIso = new Date(new Date(`${to}T00:00:00+09:00`).getTime() + 86_400_000).toISOString();
    if (new Date(toIso).getTime() - new Date(fromIso).getTime() > 400 * 86_400_000) throw new AndonError(400, "한 번에 400일까지 저장할 수 있습니다.", "BAD_RANGE");
    const { csv, rows } = await historyCsv(fromIso, toIso);
    console.info(`[history] CSV ${from}..${to} (${rows} rows) by user #${user.id}`);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="andon-history-${from}_${to}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
