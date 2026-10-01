import { AndonError } from "./andonService";

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
