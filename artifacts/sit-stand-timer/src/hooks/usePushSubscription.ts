import { useEffect, useRef, useCallback } from "react";
import { getVapidPublicKey, subscribePush, unsubscribePush } from "@workspace/api-client-react";

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
  const subscribedRef = useRef(false);

  const subscribe = useCallback(async () => {
    if (subscribedRef.current) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (notificationPermission !== "granted") return;

    try {
      const { publicKey } = await getVapidPublicKey();
      if (!publicKey) return;

      const reg = await navigator.serviceWorker.ready;
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

  useEffect(() => {
    if (notificationPermission === "granted") {
      void subscribe();
    }
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
