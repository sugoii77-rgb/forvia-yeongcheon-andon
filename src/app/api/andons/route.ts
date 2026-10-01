import { createEvent, getBoardCounts, listEvents, AndonError, type ListOptions } from "@/lib/server/andonService";
import { notifyAndonCreated } from "@/lib/server/notifications";
import { deletePhoto, savePhoto } from "@/lib/server/photos";
import { handle } from "@/lib/server/http";

export async function GET(req: Request) {
  return handle("GET /api/andons", () => {
    const q = new URL(req.url).searchParams;
    const scope = (q.get("scope") ?? "board") as ListOptions["scope"];
    const events = listEvents({
      scope,
      department: q.get("department") || undefined,
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
    });
    // serverTime lets clients correct for clock skew when showing elapsed time.
    return Response.json({ events, counts: getBoardCounts(), serverTime: new Date().toISOString() });
  });
}

// multipart/form-data: lineCode, processId, categoryCode, description, createdBy, clientRequestId, photo?
export async function POST(req: Request) {
  return handle("POST /api/andons", async () => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new AndonError(400, "요청 형식이 올바르지 않습니다.", "BAD_REQUEST");
    }
    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };

    const photo = form.get("photo");
    const photoFile = photo instanceof File && photo.size > 0 ? await savePhoto(photo) : null;

    let result;
    try {
      result = createEvent({
        lineCode: str("lineCode"),
        processId: Number(str("processId")),
        categoryCode: str("categoryCode"),
        description: str("description"),
        createdBy: str("createdBy"),
        clientRequestId: str("clientRequestId") || undefined,
        photoFile,
      });
    } catch (err) {
      if (photoFile) await deletePhoto(photoFile);
      throw err;
    }
    if (result.duplicate && photoFile) await deletePhoto(photoFile);

    if (!result.duplicate) {
      console.info(`[andon] created ${result.event.id} ${result.event.lineName}/${result.event.processName}`);
      // Fire-and-forget: the operator gets confirmation immediately; every attempt is logged.
      void notifyAndonCreated(result.event);
    }
    return Response.json(result, { status: result.duplicate ? 200 : 201 });
  });
}
