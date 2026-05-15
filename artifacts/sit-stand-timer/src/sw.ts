/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();

// ─── Asset precaching ─────────────────────────────────────────────────────────
//
// Only precache hashed JS/CSS/image assets — NOT index.html.
//
// Why exclude index.html: every deployment changes chunk filenames (content
// hashes).  If index.html is served cache-first, an old cached shell can
// reference chunk filenames that no longer exist, producing a white screen
// before any JS even runs.  We handle index.html separately below with a
// network-first strategy.
//
// Hashed assets are immutable at their URL so cache-first is always safe.

type ManifestEntry = { url: string; revision: string | null };
const assetEntries = (self.__WB_MANIFEST as ManifestEntry[]).filter(
  (e) => !e.url.endsWith(".html"),
);
precacheAndRoute(assetEntries);

// ─── Navigation: network-first ────────────────────────────────────────────────
//
// All page navigations (requests for index.html) use network-first.
// This guarantees that after a deployment the browser receives a fresh shell
// whose <script> tags reference the new chunk hashes.
//
// Behaviour:
//   • Online:  fetches from the network, caches the result, returns it.
//   • Offline: serves the previously cached copy (PWA works offline).
//   • Slow network: falls back to cache after 3 s so the app still opens.
//
// Cache name is versioned so an older SW's stale navigation cache is not
// accidentally reused by a newer SW.

registerRoute(
  new NavigationRoute(
    new NetworkFirst({
      cacheName: "posture-nav-v2",
      networkTimeoutSeconds: 3,
    }),
  ),
);

// ─── Immediate activation ─────────────────────────────────────────────────────
//
// skipWaiting: the new SW activates as soon as it finishes installing,
//   without waiting for existing tabs to close.
// clients.claim: the activated SW immediately controls all open pages.
//
// The vite-plugin-pwa autoUpdate registration code listens for the resulting
// `controllerchange` event and calls `location.reload()`, so every open tab
// gets a fresh network-first index.html and correct chunk URLs.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event: ExtendableEvent) =>
  event.waitUntil(self.clients.claim()),
);

// ─── Debug beacon ─────────────────────────────────────────────────────────────
//
// Sends a best-effort fetch to a debug endpoint so the server can record
// device-side push receipt and notification display events.
//
// Uses keepalive: true so the request survives even if the SW is about to be
// suspended after the push event completes.
// Never throws — errors are swallowed so the push handler never fails over a
// non-critical beacon.

interface BeaconPayload {
  timestamp: number;
  payloadType: string;
  traceId: string;
  userId: string;
}

function sendDebugBeacon(endpoint: string, payload: BeaconPayload): Promise<void> {
  console.log(`[SW] ${endpoint}`, payload);
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).then(() => undefined, () => undefined);
}

// ─── Posture scheduled alert ─────────────────────────────────────────────────
let scheduledAlertTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Bladder scheduled alert ─────────────────────────────────────────────────
let bladderAlertTimer: ReturnType<typeof setTimeout> | null = null;
let bladderPendingLogId = "";

function showBladderNotification(logId: string) {
  void self.registration.showNotification("Time to void", {
    body: "Go now. Do not delay.",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: "bladder-reminder",
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 600],
    data: { url: "/bladder", logId },
    actions: [
      { action: "done", title: "✓ Done" },
      { action: "snooze", title: "⏱ Snooze 5 min" },
    ],
  } as NotificationOptions);
}

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  // ── Posture notifications ──────────────────────────────────────────────────

  if (event.data?.type === "SHOW_NOTIFICATION") {
    const { title, body, icon } = event.data as {
      type: string;
      title?: string;
      body?: string;
      icon?: string;
    };
    event.waitUntil(
      self.registration.showNotification(title ?? "Timer Alert", {
        body: body ?? "Time to switch your posture.",
        icon: icon ?? "/favicon.svg",
        badge: "/favicon.svg",
        tag: "timer-reminder",
        renotify: true,
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 600],
        data: { url: "/" },
      } as NotificationOptions)
    );
  }

  if (event.data?.type === "SCHEDULE_NOTIFICATION") {
    const { delayMs, title, body } = event.data as {
      type: string;
      delayMs?: number;
      title?: string;
      body?: string;
    };

    if (scheduledAlertTimer !== null) {
      clearTimeout(scheduledAlertTimer);
      scheduledAlertTimer = null;
    }

    if (delayMs && delayMs > 0) {
      event.waitUntil(
        new Promise<void>((resolve) => {
          scheduledAlertTimer = setTimeout(() => {
            scheduledAlertTimer = null;
            void self.registration
              .showNotification(title ?? "Timer Alert", {
                body: body ?? "Time to switch your posture.",
                icon: "/favicon.svg",
                badge: "/favicon.svg",
                tag: "timer-reminder",
                renotify: true,
                requireInteraction: true,
                vibrate: [300, 100, 300, 100, 600],
                data: { url: "/" },
              } as NotificationOptions)
              .then(resolve)
              .catch(resolve);
          }, delayMs);
        })
      );
    }
  }

  if (event.data?.type === "CANCEL_SCHEDULED_NOTIFICATION") {
    if (scheduledAlertTimer !== null) {
      clearTimeout(scheduledAlertTimer);
      scheduledAlertTimer = null;
    }
  }

  // ── Bladder notifications ─────────────────────────────────────────────────

  if (event.data?.type === "SHOW_BLADDER_NOTIFICATION") {
    const { logId } = event.data as { type: string; logId?: string };
    if (logId) bladderPendingLogId = logId;
    event.waitUntil(
      self.registration.showNotification("Time to void", {
        body: "Go now. Do not delay.",
        icon: "/favicon.svg",
        badge: "/favicon.svg",
        tag: "bladder-reminder",
        renotify: true,
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 600],
        data: { url: "/bladder", logId: bladderPendingLogId },
        actions: [
          { action: "done", title: "✓ Done" },
          { action: "snooze", title: "⏱ Snooze 5 min" },
        ],
      } as NotificationOptions)
    );
  }

  if (event.data?.type === "SCHEDULE_BLADDER_NOTIFICATION") {
    const { delayMs, logId } = event.data as {
      type: string;
      delayMs?: number;
      logId?: string;
    };

    if (bladderAlertTimer !== null) {
      clearTimeout(bladderAlertTimer);
      bladderAlertTimer = null;
    }

    bladderPendingLogId = logId ?? "";

    if (delayMs && delayMs > 0) {
      event.waitUntil(
        new Promise<void>((resolve) => {
          bladderAlertTimer = setTimeout(() => {
            bladderAlertTimer = null;
            void self.registration
              .showNotification("Time to void", {
                body: "Go now. Do not delay.",
                icon: "/favicon.svg",
                badge: "/favicon.svg",
                tag: "bladder-reminder",
                renotify: true,
                requireInteraction: true,
                vibrate: [300, 100, 300, 100, 600],
                data: { url: "/bladder", logId: bladderPendingLogId },
                actions: [
                  { action: "done", title: "✓ Done" },
                  { action: "snooze", title: "⏱ Snooze 5 min" },
                ],
              } as NotificationOptions)
              .then(resolve)
              .catch(resolve);
          }, delayMs);
        })
      );
    }
  }

  if (event.data?.type === "CANCEL_BLADDER_NOTIFICATION") {
    if (bladderAlertTimer !== null) {
      clearTimeout(bladderAlertTimer);
      bladderAlertTimer = null;
    }
  }
});

self.addEventListener("push", (event: PushEvent) => {
  const data = event.data
    ? (event.data.json() as {
        title?: string;
        body?: string;
        type?: string;
        tag?: string;
        logId?: string;
        traceId?: string;
        userId?: string;
      })
    : {};

  const traceId = data.traceId ?? `unknown-${Date.now()}`;
  const userId = data.userId ?? "unknown";
  const payloadType = data.type ?? "posture";
  const now = Date.now();

  if (data.type === "bladder") {
    if (data.logId) bladderPendingLogId = data.logId;
    const capturedLogId = bladderPendingLogId;

    event.waitUntil(
      sendDebugBeacon("/api/debug/push-received", { timestamp: now, payloadType, traceId, userId })
        .then(() =>
          self.registration.showNotification(data.title ?? "Time to void", {
            body: data.body ?? "Go now. Do not delay.",
            icon: "/favicon.svg",
            badge: "/favicon.svg",
            tag: "bladder-reminder",
            renotify: true,
            requireInteraction: true,
            vibrate: [300, 100, 300, 100, 600],
            data: { url: "/bladder", logId: capturedLogId },
            actions: [
              { action: "done", title: "✓ Done" },
              { action: "snooze", title: "⏱ Snooze 5 min" },
            ],
          } as NotificationOptions),
        )
        .then(() =>
          sendDebugBeacon("/api/debug/notification-shown", { timestamp: Date.now(), payloadType, traceId, userId }),
        )
        .catch(() => {}),
    );
    return;
  }

  if (data.type === "posture" || data.type == null) {
    event.waitUntil(
      sendDebugBeacon("/api/debug/push-received", { timestamp: now, payloadType, traceId, userId })
        .then(() =>
          self.registration.showNotification(data.title ?? "Timer Alert", {
            body: data.body ?? "Time to switch your posture.",
            icon: "/favicon.svg",
            badge: "/favicon.svg",
            tag: data.tag ?? "timer-reminder",
            renotify: false,
            requireInteraction: true,
            vibrate: [300, 100, 300, 100, 600],
            data: { url: "/" },
          } as NotificationOptions),
        )
        .then(() =>
          sendDebugBeacon("/api/debug/notification-shown", { timestamp: Date.now(), payloadType, traceId, userId }),
        )
        .catch(() => {}),
    );
  }
});

function openOrNavigate(
  windowClients: readonly WindowClient[],
  url: string,
): Promise<WindowClient | null> {
  if (windowClients.length === 0) {
    return self.clients.openWindow(url);
  }
  const target = windowClients[0];
  const currentPath = new URL(target.url as string).pathname;
  const targetPath = new URL(url, "https://placeholder").pathname;
  if (currentPath === targetPath) {
    return target.focus().then(() => null);
  }
  return (target as WindowClient)
    .navigate(url)
    .then(() => target.focus())
    .catch(() => target.focus().then(() => null));
}

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();

  const tag = event.notification.tag as string;
  const action = event.action as string;
  const notifData = event.notification.data as { url?: string; logId?: string } | null;

  if (tag === "bladder-reminder") {
    if (action === "done") {
      event.waitUntil(
        self.clients
          .matchAll({ type: "window", includeUncontrolled: true })
          .then((clients) => {
            clients.forEach((c) =>
              c.postMessage({ type: "BLADDER_ACTION_DONE", logId: notifData?.logId ?? "" }),
            );
            if (clients.length === 0) {
              return self.clients.openWindow(notifData?.url ?? "/bladder");
            }
            return undefined;
          }),
      );
      return;
    }

    if (action === "snooze") {
      const snoozeMs = 5 * 60 * 1000;
      const currentLogId = bladderPendingLogId || (notifData?.logId ?? "");
      event.waitUntil(
        new Promise<void>((resolve) => {
          self.clients
            .matchAll({ type: "window", includeUncontrolled: true })
            .then((clients) =>
              clients.forEach((c) =>
                c.postMessage({ type: "BLADDER_ACTION_SNOOZE", logId: currentLogId }),
              ),
            ).catch(() => { /* ignore */ });

          setTimeout(() => {
            showBladderNotification(currentLogId);
            resolve();
          }, snoozeMs);
        }),
      );
      return;
    }

    event.waitUntil(
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((windowClients) => openOrNavigate(windowClients, notifData?.url ?? "/bladder")),
    );
    return;
  }

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => openOrNavigate(windowClients, notifData?.url ?? "/")),
  );
});
