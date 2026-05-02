/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Activate immediately and claim all open clients so updates take effect
// without requiring the user to close and reopen the app.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event: ExtendableEvent) =>
  event.waitUntil(self.clients.claim()),
);

// Scheduled background alert — cancelled when the page comes back to foreground.
let scheduledAlertTimer: ReturnType<typeof setTimeout> | null = null;

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

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
      // event.waitUntil keeps the SW alive until the promise resolves,
      // which is when the notification fires.
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
});

self.addEventListener("push", (event: PushEvent) => {
  const data = event.data ? (event.data.json() as { title?: string; body?: string }) : {};
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Timer Alert", {
      body: data.body ?? "Time to switch your posture.",
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      data: { url: "/" },
    } as NotificationOptions)
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        if (windowClients.length > 0) {
          const focused =
            windowClients.find((c) => c.focused) ?? windowClients[0];
          return focused.focus();
        }
        return self.clients.openWindow("/");
      })
  );
});
