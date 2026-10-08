// Session lifetime shared by auth.ts and src/proxy.ts (no DB import, so the proxy stays light).
// Sliding expiry: every use of a session pushes its expiry SESSION_IDLE_DAYS (default 90) ahead, so a
// user who logs in once stays logged in as long as the app is opened at least once in that period.
// Logout, a password change / reset and deactivation still end the session at once (checked in the DB).

export const SESSION_COOKIE = "andon_session";
export const SESSION_IDLE_MS = Math.max(1, Number(process.env.SESSION_IDLE_DAYS || 90)) * 86_400_000;

export function secureCookieFor(url: string, forwardedProto: string | null): boolean {
  const mode = (process.env.COOKIE_SECURE || "auto").toLowerCase();
  if (mode === "true") return true;
  if (mode === "false") return false;
  return new URL(url).protocol === "https:" || forwardedProto === "https";
}
