const CACHE_NAME = "sit-stand-v1";
const PRECACHE_URLS = ["/", "/index.html", "/manifest.json", "/favicon.svg"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {}))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached || new Response("Offline", { status: 503 }));
      return cached || networkFetch;
    })
  );
});

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "SHOW_NOTIFICATION") return;
  const { title, body, icon } = event.data;
  event.waitUntil(
    self.registration.showNotification(title || "Timer Alert", {
      body: body || "Time to switch your posture.",
      icon: icon || "/favicon.svg",
      badge: "/favicon.svg",
      vibrate: [200, 100, 200],
      tag: "timer-reminder",
      renotify: true,
      data: { url: "/" },
    })
  );
});

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || "Timer Alert", {
      body: data.body || "Time to switch your posture.",
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      vibrate: [200, 100, 200],
      data: { url: "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        if (windowClients.length > 0) {
          const focused = windowClients.find((c) => c.focused) || windowClients[0];
          return focused.focus();
        }
        return clients.openWindow("/");
      })
  );
});
