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

// 3) KakaoTalk's built-in browser does not keep the login cookie (a GAP leader opening ANDON from a Kakao
//    message had to log in again every time, 2026-11-25): pages opened there go to the phone's own browser
//    (Chrome / Safari) through KakaoTalk's openExternal link, where the login stays and phone alerts work.
function openInExternalBrowser(url: string) {
  const target = `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
  const attr = target.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ANDON</title></head>
<body style="font-family:sans-serif;padding:24px;line-height:1.6">
<p><b>ANDON을 휴대폰 기본 브라우저(Chrome / Safari)에서 엽니다.</b></p>
<p>열리지 않으면 아래 버튼을 누르거나, 오른쪽 위 메뉴에서 ‘다른 브라우저로 열기’를 누르세요.</p>
<p><a href="${attr}" style="display:inline-block;padding:12px 18px;background:#1f3864;color:#fff;border-radius:8px;text-decoration:none">브라우저로 열기</a></p>
<script>location.href=${JSON.stringify(target).replace(/</g, "\\u003c")};</script>
</body></html>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function proxy(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const path = req.nextUrl.pathname;
  if (req.method === "GET" && !path.startsWith("/api/") && /KAKAOTALK/i.test(req.headers.get("user-agent") ?? "")) {
    return openInExternalBrowser(req.nextUrl.href);
  }
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
  matcher: ["/((?!_next/static|_next/image|favicon.ico|pwa/|manual|sw.js|andon-guide|andon-alert|quickstart|api/andons).*)"],
};
