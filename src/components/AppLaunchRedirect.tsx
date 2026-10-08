"use client";
// Home screen opened as an installed app (icon) by a GAP leader / supervisor: go straight to the call
// screen. Covers icons added before the manifest start page (/start) existed and iPhones, which open the
// page that was added. In a normal browser tab the menu stays.
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMe } from "@/lib/client";
import { CALL_ROLES } from "@/lib/domain";

export function AppLaunchRedirect() {
  const { user } = useMe();
  const router = useRouter();
  useEffect(() => {
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone && user?.active && CALL_ROLES.includes(user.role)) router.replace("/operator");
  }, [user, router]);
  return null;
}
