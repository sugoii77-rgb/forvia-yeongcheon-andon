import { AndonError, type AuditInfo } from "./errors.ts";

/** Header carrying the browser's persistent device id (src/lib/client.ts deviceId()). */
export const DEVICE_HEADER = "x-andon-device";
const DEVICE_ID = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Device / network information recorded with every state change.
 * - deviceId: random id generated once per browser (localStorage); invalid values are dropped.
 * - clientIp: as reported to the server (x-forwarded-for, which Next.js fills from the socket when
 *   the client did not send one). Not authenticated — a client can forge it.
 */
export function requestAudit(req: Request): AuditInfo {
  const dev = req.headers.get(DEVICE_HEADER)?.trim() ?? "";
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ip = fwd.replace(/^::ffff:/, "").slice(0, 64);
  const ua = req.headers.get("user-agent")?.slice(0, 300) ?? "";
  return {
    deviceId: DEVICE_ID.test(dev) ? dev : null,
    clientIp: ip || null,
    userAgent: ua || null,
  };
}

/** Wraps a route handler: maps AndonError to its status, logs and returns 500 for anything else. */
export async function handle(label: string, fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AndonError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error(`[api] ${label} failed`, err);
    return Response.json(
      { error: "서버 오류가 발생했습니다. 잠시 후 다시 시도하세요.", code: "SERVER_ERROR" },
      { status: 500 },
    );
  }
}
