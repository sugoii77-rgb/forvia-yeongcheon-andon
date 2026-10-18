import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_IDLE_MS, secureCookieFor } from "@/lib/server/sessionPolicy";

// 1) Pages with plant data open only for signed-in users (plant 2026-10-19): without a session cookie the
//    browser goes to the login page first (a shared link or QR code alone shows nothing). The real check is
//    on the server — every data API answers 401 without a valid session (requireSignedIn); this redirect
//    only spares strangers an empty page.
// 2) Keeps the browser's session cookie alive while the app is in use (sliding expiry; the server-side
//    expiry is extended in getSessionUser). Only re-sends the cookie the browser already has — validity
//    is still decided by the database on every request. /api/auth/* sets / clears the cookie itself.
const PROTECTED = ["/dashboard", "/history", "/respond", "/operator", "/me", "/admin"];
const isProtected = (p: string) => p === "/" || PROTECTED.some((x) => p === x || p.startsWith(`${x}/`));

export function proxy(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const path = req.nextUrl.pathname;
  if ((!token || token.length > 100) && isProtected(path)) {
    const login = new URL("/login", req.url);
    if (path !== "/") login.searchParams.set("next", path + req.nextUrl.search);
    return NextResponse.redirect(login);
  }
  const res = NextResponse.next();
  if (!token || token.length > 100 || path.startsWith("/api/auth/")) return res;
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
// would cut an oversized multipart ANDON call before the route can answer it properly (the route checks the
// session itself). Static files, the manual and the help assets stay public.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|pwa/|manual.html|sw.js|andon-guide|andon-alert|quickstart|api/andons).*)"],
};
