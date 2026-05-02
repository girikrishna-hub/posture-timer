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
            showBladderNotification(bladderPendingLogId);
            resolve();
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

  const tag = event.notification.tag as string;
  const action = event.action as string;
  const notifData = event.notification.data as { url?: string; logId?: string } | null;

  // ── Bladder actions ────────────────────────────────────────────────────────
  if (tag === "bladder-reminder") {
    if (action === "done") {
      // Notify all open clients so BladderContext can record done_on_time
      event.waitUntil(
        self.clients
          .matchAll({ type: "window", includeUncontrolled: true })
          .then((clients) => {
            clients.forEach((c) =>
              c.postMessage({ type: "BLADDER_ACTION_DONE", logId: notifData?.logId ?? "" }),
            );
            if (clients.length === 0) {
              // App not open — open it so user can confirm
              void self.clients.openWindow(notifData?.url ?? "/bladder");
            }
          }),
      );
      return;
    }

    if (action === "snooze") {
      // Re-show notification in 5 minutes
      const snoozeMs = 5 * 60 * 1000;
      const currentLogId = bladderPendingLogId || (notifData?.logId ?? "");
      event.waitUntil(
        new Promise<void>((resolve) => {
          // Notify clients of snooze so they can acknowledge in UI
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

    // Default click → open app at bladder page
    event.waitUntil(
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((windowClients) => {
          const bladderClients = windowClients.filter(
            (c) => (c.url as string).includes("/bladder"),
          );
          const target = bladderClients[0] ?? windowClients[0];
          if (target) return target.focus();
          return self.clients.openWindow(notifData?.url ?? "/bladder");
        }),
    );
    return;
  }

  // ── Default (posture) notification click ──────────────────────────────────
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
