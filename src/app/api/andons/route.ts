import { createEvent, getBoardCounts, listEvents, AndonError, type ListOptions } from "@/lib/server/andonService";
import { notifyAndonCreated } from "@/lib/server/notifications";
import { deletePhoto, savePhoto } from "@/lib/server/photos";
import { handle, requestAudit } from "@/lib/server/http";

export async function GET(req: Request) {
  return handle("GET /api/andons", () => {
    const q = new URL(req.url).searchParams;
    const scope = (q.get("scope") ?? "board") as ListOptions["scope"];
    const responderId = Number(q.get("responderId"));
    const events = listEvents({
      scope,
      department: q.get("department") || undefined,
      responderId: Number.isInteger(responderId) && responderId > 0 ? responderId : undefined,
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

    // The photo is optional: any problem with it (type, size, disk) must never block the ANDON call.
    // The event is created without the photo and the client is told why.
    const photo = form.get("photo");
    let photoFile: string | null = null;
    let photoWarning: string | null = null;
    if (photo instanceof File && photo.size > 0) {
      try {
        photoFile = await savePhoto(photo);
      } catch (err) {
        photoWarning = err instanceof AndonError ? err.message : "사진 저장에 실패했습니다.";
        console.warn(`[andon] photo not attached (${photo.type || "no type"}, ${photo.size} B): ${String(err)}`);
      }
    }

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
        audit: requestAudit(req),
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
    return Response.json(
      { ...result, photoWarning: result.duplicate ? null : photoWarning },
      { status: result.duplicate ? 200 : 201 },
    );
  });
}
