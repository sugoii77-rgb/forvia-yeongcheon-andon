"use client";
// /me → "휴대폰 알림 (알림음)": turn on Web Push for THIS device. KakaoTalk "send to me" arrives silently;
// push notifications ring with the phone's normal notification sound. Per device (phone, office PC, …).
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

interface PushStatus {
  configured: boolean;
  publicKey: string | null;
  devices: number;
}

type Env = "ok" | "unsupported" | "ios-browser" | "in-app";

function detectEnv(): Env {
  const ua = navigator.userAgent;
  if (/KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\//i.test(ua)) return "in-app";
  const ios = /iPhone|iPad|iPod/i.test(ua);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return "ios-browser";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "ok";
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Called before logout: a shared phone must not keep ringing for the previous user. Best effort. */
export async function pushOffBeforeLogout(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator)) return;
    const sub = await currentSubscription();
    if (!sub) return;
    await api("/api/notify/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe();
  } catch {
    /* logout continues */
  }
}

export function PushNotify() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [env, setEnv] = useState<Env | null>(null);
  const [onHere, setOnHere] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const e = detectEnv();
    setEnv(e);
    try {
      setStatus(await api<PushStatus>("/api/notify/push"));
    } catch {
      setStatus(null);
    }
    if (e === "ok") setOnHere(!!(await currentSubscription().catch(() => null)) && Notification.permission === "granted");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function turnOn() {
    if (!status?.publicKey) return;
    setBusy("on");
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setMsg({ ok: false, text: "알림이 차단되어 있습니다. 브라우저(또는 휴대폰 설정 → 앱 → Chrome/ANDON → 알림)에서 이 사이트의 알림을 '허용'으로 바꾼 뒤 다시 누르세요." });
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (sub) {
        // a subscription made with another key cannot be used → renew
        const k = sub.options.applicationServerKey;
        const same = k && btoa(String.fromCharCode(...new Uint8Array(k))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === status.publicKey;
        if (!same) {
          await sub.unsubscribe();
          sub = null;
        }
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey) });
      await api("/api/notify/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      await api("/api/notify/push/test", { method: "POST" }).catch(() => {});
      setMsg({ ok: true, text: "이 기기의 알림을 켰습니다. 테스트 알림을 보냈습니다 — 알림음이 울렸는지 확인하세요." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message || "알림을 켜지 못했습니다." });
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function test() {
    setBusy("test");
    setMsg(null);
    try {
      await api("/api/notify/push/test", { method: "POST" });
      setMsg({ ok: true, text: "테스트 알림을 보냈습니다. 알림이 켜진 모든 기기에서 울립니다." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function turnOff() {
    setBusy("off");
    setMsg(null);
    try {
      await pushOffBeforeLogout();
      setMsg({ ok: true, text: "이 기기의 알림을 껐습니다." });
    } finally {
      setBusy(null);
      await load();
    }
  }

  if (!status?.configured || env === null) return null;
  return (
    <div className="card" data-testid="push-notify">
      <h2 style={{ marginTop: 0 }}>
        휴대폰 알림 (알림음) <span className="muted" style={{ fontSize: 14 }}>Push</span>
      </h2>
      <p className="muted" style={{ fontSize: 14 }}>
        카카오톡 &lsquo;나와의 채팅&rsquo;은 알림음이 울리지 않습니다. 여기서 알림을 켜면 ANDON이 올 때 휴대폰 알림음·진동이 함께 울립니다. 기기마다 한 번씩 켜 주세요.
      </p>
      <dl className="kv">
        <dt>이 기기</dt>
        <dd data-testid="push-state">{onHere ? "✔ 알림 켜짐" : "꺼짐"}</dd>
        <dt>알림 켜진 기기</dt>
        <dd>{status.devices}대</dd>
      </dl>
      {env === "in-app" && (
        <div className="alert alert-error">
          카카오톡 등 앱 안의 브라우저에서는 알림을 켤 수 없습니다. 오른쪽 위 메뉴에서 &lsquo;다른 브라우저로 열기&rsquo;(Chrome / Safari)를 누른 뒤 다시 시도하세요.
        </div>
      )}
      {env === "ios-browser" && (
        <div className="alert alert-error">
          아이폰은 Safari에서 <b>공유 → 홈 화면에 추가</b>로 ANDON 아이콘을 만든 뒤, <b>그 아이콘으로 열어서</b> 알림을 켜야 합니다. (iOS 16.4 이상)
        </div>
      )}
      {env === "unsupported" && <div className="alert alert-error">이 브라우저는 알림을 지원하지 않습니다. Chrome에서 열어 주세요.</div>}
      {msg && <div className={`alert ${msg.ok ? "alert-ok" : "alert-error"}`}>{msg.text}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        {env === "ok" && !onHere && (
          <button className="btn btn-primary" onClick={turnOn} disabled={!!busy}>
            {busy === "on" ? "켜는 중…" : "이 기기 알림 켜기"}
          </button>
        )}
        {status.devices > 0 && (
          <button className="btn" onClick={test} disabled={!!busy}>
            {busy === "test" ? "보내는 중…" : "테스트 알림"}
          </button>
        )}
        {env === "ok" && onHere && (
          <button className="btn" onClick={turnOff} disabled={!!busy}>
            {busy === "off" ? "끄는 중…" : "이 기기 알림 끄기"}
          </button>
        )}
      </div>
    </div>
  );
}
