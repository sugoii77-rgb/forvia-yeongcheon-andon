"use client";
// Home tile to the setup-status page — only for those who may open it (GL · SV · plant manager · 팀장).
import Link from "next/link";
import { useMe } from "@/lib/client";
import { canViewSetupStatus } from "@/lib/domain";

export function SetupTile() {
  const { user } = useMe();
  if (!canViewSetupStatus(user)) return null;
  return (
    <Link href="/admin/setup" className="tile">
      <strong>설정 현황</strong>로그인 · 카카오 연결 · 알림음 (부서별)
    </Link>
  );
}
