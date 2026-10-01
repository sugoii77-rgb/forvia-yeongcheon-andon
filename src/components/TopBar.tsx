"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/operator", label: "ANDON 호출" },
  { href: "/dashboard", label: "현황판" },
  { href: "/respond", label: "조치 (담당자)" },
  { href: "/history", label: "이력/통계" },
];

export function TopBar() {
  const path = usePathname();
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        DIGITAL ANDON<small>Yeongcheon</small>
      </Link>
      <nav>
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={path.startsWith(l.href) ? "active" : ""}>
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
