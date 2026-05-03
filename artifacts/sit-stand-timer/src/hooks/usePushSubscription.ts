import { useEffect, useRef, useCallback } from "react";
import { getVapidPublicKey, subscribePush, unsubscribePush, getHasSubscription } from "@workspace/api-client-react";

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buf = new ArrayBuffer(rawData.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < rawData.length; i++) {
    view[i] = rawData.charCodeAt(i);
  }
  return view;
}

export function usePushSubscription(notificationPermission: NotificationPermission) {
  // Tracks whether we have already attempted registration in this session.
  // Reset to false if the server reports no valid subscription, so we can
  // force a fresh browser push registration (new endpoint).
  const subscribedRef = useRef(false);

  const subscribe = useCallback(async (force = false) => {
    if (subscribedRef.current && !force) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (notificationPermission !== "granted") return;

    try {
      const { publicKey } = await getVapidPublicKey();
      if (!publicKey) return;

      const reg = await navigator.serviceWorker.ready;

      if (force) {
        // The server's subscription was deleted (e.g. 410 from the push
        // service). The browser's existing subscription has the same stale
        // endpoint. Unsubscribe from the browser to force a new endpoint.
        const existing = await reg.pushManager.getSubscription();
        if (existing) await existing.unsubscribe();
      }

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      const json = sub.toJSON();
      const keys = json.keys as { p256dh?: string; auth?: string } | undefined;
      if (!json.endpoint || !keys?.p256dh || !keys?.auth) return;

      await subscribePush({
        endpoint: json.endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
      });

      subscribedRef.current = true;
    } catch {
      // Silently ignore — subscription is best-effort
    }
  }, [notificationPermission]);

  // On mount and whenever the permission is granted: check whether the server
  // still holds a valid subscription for this user. If it was deleted (e.g.
  // because a push attempt returned 410 Gone from the push service), force the
  // browser to get a fresh push registration with a new endpoint.
  useEffect(() => {
    if (notificationPermission !== "granted") return;

    async function checkAndSubscribe() {
      try {
        const { hasSubscription } = await getHasSubscription();
        if (!hasSubscription) {
          // Server has no subscription — force a fresh browser registration.
          subscribedRef.current = false;
          await subscribe(true);
        } else {
          await subscribe();
        }
      } catch {
        // Fall back to normal subscribe attempt
        await subscribe();
      }
    }

    void checkAndSubscribe();
  }, [notificationPermission, subscribe]);

  // Re-check on visibility change (foreground return).
  // This catches the common case where a push fired while backgrounded,
  // got a 410, deleted the subscription, and the user returns to the app.
  useEffect(() => {
    if (notificationPermission !== "granted") return;

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      subscribedRef.current = false; // always re-verify on foreground return
      void subscribe();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [notificationPermission, subscribe]);

  const unsubscribe = useCallback(async () => {
    if (!("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await unsubscribePush({ endpoint });
      subscribedRef.current = false;
    } catch {
      // Silently ignore
    }
  }, []);

  return { unsubscribe };
}
