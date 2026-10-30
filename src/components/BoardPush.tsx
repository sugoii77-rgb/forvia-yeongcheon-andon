"use client";
// Event-driven shop-floor board (2026-10-29, Vercel free-tier CPU): instead of loading the board every 5 s,
// the display's browser is registered as a BOARD push device and the server sends a silent "board changed"
// signal when an ANDON is raised / acknowledged / in action / completed (src/lib/server/webPush.ts →
// public/sw.js → usePolling). Needs the browser's notification permission once per display PC.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { detectEnv, keyBytes } from "@/components/PushNotify";

interface PushStatus {
  configured: boolean;
  publicKey: string | null;
  thisDevice?: boolean;
  thisDeviceBoard?: boolean;
}

/** on: updates arrive by push. off: can be turned on (button). blocked: permission denied. unsupported: no push. */
export type BoardPushState = "checking" | "on" | "off" | "blocked" | "unsupported";

async function register(publicKey: string): Promise<void> {
  const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // a subscription made with another key cannot be used → renew
    const k = sub.options.applicationServerKey;
    const same = k && btoa(String.fromCharCode(...new Uint8Array(k))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === publicKey;
    if (!same) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api("/api/notify/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), kind: "BOARD" }),
  });
}

/**
 * Keeps this display registered for board pushes. When notifications are already allowed it (re-)registers
 * by itself — the display PC needs no clicks after the first time. `enable` asks for the permission.
 */
export function useBoardPush(): { state: BoardPushState; enable: () => Promise<void> } {
  const [state, setState] = useState<BoardPushState>("checking");

  const check = useCallback(async () => {
    if (detectEnv() !== "ok") return setState("unsupported");
    if (Notification.permission === "denied") return setState("blocked");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      const status = await api<PushStatus>(`/api/notify/push${sub ? `?endpoint=${encodeURIComponent(sub.endpoint)}` : ""}`);
      if (!status.configured || !status.publicKey) return setState("unsupported");
      if (sub && status.thisDeviceBoard && Notification.permission === "granted") return setState("on");
      if (Notification.permission !== "granted") return setState("off");
      await register(status.publicKey); // allowed but not (or no longer) registered: renew quietly
      setState("on");
    } catch (err) {
      console.warn("[board-push] registration failed", err);
      setState("off");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(check, 0);
    const t = setInterval(check, 30 * 60_000); // the push service may drop a registration: re-check now and then
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [check]);

  const enable = useCallback(async () => {
    if (detectEnv() !== "ok") return setState("unsupported");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return setState(perm === "denied" ? "blocked" : "off");
    await check();
  }, [check]);

  return { state, enable };
}
