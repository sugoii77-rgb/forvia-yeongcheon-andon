import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_IDLE_MS, secureCookieFor } from "@/lib/server/sessionPolicy";

// Keeps the browser's session cookie alive while the app is in use (sliding expiry; the server-side
// expiry is extended in getSessionUser). Only re-sends the cookie the browser already has — validity
// is still decided by the database on every request. /api/auth/* sets / clears the cookie itself.
export function proxy(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const res = NextResponse.next();
  if (!token || token.length > 100 || req.nextUrl.pathname.startsWith("/api/auth/")) return res;
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: Math.floor(SESSION_IDLE_MS / 1000),
    secure: secureCookieFor(req.url, req.headers.get("x-forwarded-proto")),
  });
  return res;
}

// /api/andons is excluded: a proxy buffers request bodies only up to 10 MB (proxyClientMaxBodySize), which
// would cut an oversized multipart ANDON call before the route can answer it properly. Pages and the other
// API calls still refresh the cookie.
export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|pwa/|manual.html|sw.js|andon-guide|api/andons).*)", has: [{ type: "cookie", key: "andon_session" }] }],
};
