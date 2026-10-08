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
      data: { url: d.url || "/" },
      lang: "ko",
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
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
