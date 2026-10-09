// Digital ANDON service worker — phone push notifications only (no offline cache).
// The server sends { title, body, url, tag } (src/lib/server/webPush.ts).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: "Digital ANDON", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "Digital ANDON", {
      body: d.body || "",
      tag: d.tag || undefined,
      renotify: !!d.tag, // a repeated tag still rings
      requireInteraction: true, // stays until tapped (desktop)
      vibrate: [400, 150, 400, 150, 400],
      icon: "/pwa/icon-192.png",
      badge: "/pwa/icon-192.png",
      data: { url: d.url || "/", ack: d.ack || null },
      // one-tap acknowledge (Android / desktop Chrome; iPhone shows no buttons — a tap opens the page)
      actions: d.ack ? [{ action: "ack", title: d.ack.title }] : [],
      lang: "ko",
    }),
  );
});

// [접수] / [수리 시작] tapped: acknowledge with this device's own session, then confirm with a notification.
async function acknowledge(n) {
  const { ack, url } = n.data || {};
  const done = (title, body, openUrl) =>
    self.registration.showNotification(title, { body, tag: n.tag || undefined, icon: "/pwa/icon-192.png", badge: "/pwa/icon-192.png", data: { url: openUrl || url }, lang: "ko" });
  try {
    const res = await fetch(`/api/andons/${encodeURIComponent(ack.eventId)}/transition`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-andon-device": "push-action" },
      body: JSON.stringify({ action: "ACKNOWLEDGE" }),
    });
    if (res.ok) return done(`✔ ${ack.title} 완료`, `${n.title.replace(/^\[ANDON 발생\]\s*/, "")}\n탭하면 상세 화면이 열립니다.`);
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) return self.clients.openWindow(`/login?next=${encodeURIComponent(new URL(url, self.location.origin).pathname)}`);
    if (res.status === 409) return done("이미 처리된 ANDON입니다", "다른 담당자가 먼저 접수했거나 이미 완료되었습니다.\n탭하면 상세 화면이 열립니다.");
    return done(`${ack.title}하지 못했습니다`, (err.error || `오류 ${res.status}`) + "\n탭하면 상세 화면이 열립니다.");
  } catch {
    return done(`${ack.title}하지 못했습니다`, "네트워크를 확인하세요. 탭하면 상세 화면이 열립니다.");
  }
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  if (e.action === "ack" && e.notification.data && e.notification.data.ack) {
    e.waitUntil(acknowledge(e.notification));
    return;
  }
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin);
  if (url.origin !== self.location.origin) return;
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("navigate" in w && new URL(w.url).origin === url.origin) {
          await w.focus();
          return w.navigate(url.href);
        }
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});

// The browser rotated the subscription: re-subscribe and tell the server (session cookie goes along).
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    (async () => {
      const old = e.oldSubscription;
      const key = old && old.options ? old.options.applicationServerKey : null;
      if (!key) return;
      const sub = e.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await fetch("/api/notify/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), oldEndpoint: old.endpoint }),
      });
    })(),
  );
});
