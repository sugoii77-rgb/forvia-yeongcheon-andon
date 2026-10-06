import { createEvent, getBoardCounts, listEvents, AndonError, type ListOptions } from "@/lib/server/andonService";
import { notifyAndonCreated } from "@/lib/server/notifications";
import { deletePhoto, savePhoto } from "@/lib/server/photos";
import { after } from "next/server";
import { handle, requestAudit } from "@/lib/server/http";
import { assertSameOrigin, getSessionUser } from "@/lib/server/auth";
import { CALL_ROLES } from "@/lib/domain";
import { publicShift } from "@/lib/server/shiftService";

export async function GET(req: Request) {
  return handle("GET /api/andons", async () => {
    const q = new URL(req.url).searchParams;
    const scope = (q.get("scope") ?? "board") as ListOptions["scope"];
    // mine=1: only events of the logged-in user's department (decided on the server from the session).
    let responderId: number | undefined;
    if (q.get("mine") === "1") {
      const user = await getSessionUser(req);
      if (!user) throw new AndonError(401, "로그인이 필요합니다.", "AUTH_REQUIRED");
      responderId = user.id;
    }
    const events = await listEvents({
      scope,
      department: q.get("department") || undefined,
      responderId,
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
    });
    // serverTime lets clients correct for clock skew when showing elapsed time. The board (shop-floor
    // display) also gets the shift on duty — team + DAY/NIGHT only, or UNRESOLVED; never the anchor.
    const shift = scope === "board" ? await publicShift() : undefined;
    return Response.json({ events, counts: await getBoardCounts(), serverTime: new Date().toISOString(), ...(shift ? { shift } : {}) });
  });
}

// multipart/form-data: lineCode, processId, categoryCode, description, clientRequestId, photo?,
// departments (repeated; the responsible departments), recipients (repeated user ids; who gets the message).
// Caller = the logged-in GAP leader / supervisor (plant decision 2026-10-06: the GAP leader calls the ANDON).
// Without `departments` the routing rule decides one department and the department rule the recipients.
export async function POST(req: Request) {
  return handle("POST /api/andons", async () => {
    assertSameOrigin(req);
    const caller = await getSessionUser(req);
    if (!caller) throw new AndonError(401, "ANDON 호출은 로그인한 GAP 리더만 할 수 있습니다.", "AUTH_REQUIRED");
    if (!caller.active) throw new AndonError(403, "비활성(사용 중지)된 계정입니다.", "ACCOUNT_INACTIVE");
    if (!CALL_ROLES.includes(caller.role)) throw new AndonError(403, "ANDON 호출은 GAP 리더·감독자만 할 수 있습니다.", "ROLE_NOT_ALLOWED");
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
      result = await createEvent({
        lineCode: str("lineCode"),
        processId: Number(str("processId")),
        categoryCode: str("categoryCode"),
        description: str("description"),
        caller: { id: caller.id, name: caller.name, departmentCode: caller.departmentCode, role: caller.role },
        departments: form.getAll("departments").length ? form.getAll("departments").map(String) : undefined,
        recipientIds: form.getAll("recipients").map((v) => Number(v)),
        situations: form.getAll("situations").map(String),
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
      // After the response: the operator gets confirmation immediately; every attempt is logged.
      // after() keeps the work alive until it finishes, also on serverless platforms.
      const created = result.event;
      after(() => notifyAndonCreated(created));
    }
    return Response.json(
      { ...result, photoWarning: result.duplicate ? null : photoWarning },
      { status: result.duplicate ? 200 : 201 },
    );
  });
}
