"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMe } from "@/lib/client";
import { LangToggle, useT } from "@/lib/i18n";
import { PushAutoHeal } from "@/components/PushNotify";

const LINKS = [
  { href: "/operator", ko: "ANDON 호출", en: "Call ANDON" },
  { href: "/dashboard", ko: "현황판", en: "Dashboard" },
  { href: "/respond", ko: "조치 (담당자)", en: "Respond" },
  { href: "/history", ko: "이력/통계", en: "History" },
  { href: "/help", ko: "도움말", en: "Help" },
];

export function TopBar() {
  const path = usePathname();
  const { user, loaded } = useMe();
  const t = useT();
  return (
    <header className="topbar">
      <PushAutoHeal signedIn={!!user?.active} />
      <Link href="/" className="brand">
        DIGITAL ANDON<small>Yeongcheon</small>
      </Link>
      <nav>
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={path.startsWith(l.href) ? "active" : ""}>
            {t(l.ko, l.en)}
          </Link>
        ))}
        {loaded &&
          (user ? (
            <Link
              href="/me"
              className={`tb-me${path.startsWith("/me") ? " active" : ""}`}
              aria-label={`${user.name} · ${t("내 정보 / 설정", "My account / settings")}`}
              title={t("내 정보 · 설정 (알림음 · 카카오 · 비밀번호)", "My account · settings (alerts · KakaoTalk · password)")}
            >
              <span>{user.name}</span>
              <GearIcon />
            </Link>
          ) : (
            <Link href={`/login?next=${encodeURIComponent(path)}`} className={path.startsWith("/login") ? "active" : ""}>
              {t("로그인", "Log in")}
            </Link>
          ))}
        <LangToggle />
      </nav>
    </header>
  );
}
/** Outline gear (settings) — same link as the name: one tap target to '내 정보'. */
function GearIcon() {
  return (
    <svg className="tb-gear" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
