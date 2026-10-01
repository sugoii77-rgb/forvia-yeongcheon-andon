import { getMasterData } from "@/lib/server/andonService";
import { handle } from "@/lib/server/http";

export async function GET() {
  return handle("GET /api/meta", async () => Response.json(await getMasterData()));
}
