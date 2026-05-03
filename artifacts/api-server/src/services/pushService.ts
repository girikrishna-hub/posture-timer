import webpush from "web-push";
import { db, pushSubscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const vapidPublicKey  = process.env["VAPID_PUBLIC_KEY"]  ?? "";
const vapidPrivateKey = process.env["VAPID_PRIVATE_KEY"] ?? "";
const vapidSubject    = process.env["VAPID_SUBJECT"]     ?? "mailto:admin@example.com";

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

export { vapidPublicKey };

export interface PushPayload {
  title: string;
  body: string;
  type?: "posture" | "bladder";
  tag?: string;
  logId?: string;
  /**
   * Trace identifier for this notification cycle.
   * Echoed back by the service worker in push-received / notification-shown
   * beacons so a single notification can be correlated end-to-end:
   *   timer.fired → push.send.attempt → push-received → notification-shown
   */
  traceId?: string;
  /**
   * userId embedded in the encrypted push payload.
   * The service worker echoes this back in receipt beacons so the server can
   * attribute device-side events to the correct user without auth.
   */
  userId?: string;
}

export async function saveSubscription(
  userId: string,
  endpoint: string,
  p256dh: string,
  auth: string,
): Promise<void> {
  await db
    .insert(pushSubscriptionsTable)
    .values({ userId, endpoint, p256dh, auth })
    .onConflictDoUpdate({
      target: pushSubscriptionsTable.endpoint,
      set: { userId, p256dh, auth },
    });
}

export async function hasSubscription(userId: string): Promise<boolean> {
  const rows = await db
    .select({ endpoint: pushSubscriptionsTable.endpoint })
    .from(pushSubscriptionsTable)
    .where(eq(pushSubscriptionsTable.userId, userId))
    .limit(1);
  return rows.length > 0;
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  await db
    .delete(pushSubscriptionsTable)
    .where(eq(pushSubscriptionsTable.endpoint, endpoint));
}

async function sendToSubscriptions(
  userId: string,
  subs: { endpoint: string; p256dh: string; auth: string }[],
  payload: PushPayload,
): Promise<void> {
  const payloadType = payload.type ?? "posture";
  const traceId = payload.traceId ?? null;

  const results = await Promise.allSettled(
    subs.map((sub) => {
      logger.info(
        {
          event: "push.send.attempt",
          userId,
          traceId,
          endpoint: sub.endpoint,
          payloadType,
        },
        "Push send attempt",
      );
      return webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const sub = subs[i]!;

    if (r.status === "fulfilled") {
      logger.info(
        {
          event: "push.send.result",
          userId,
          traceId,
          endpoint: sub.endpoint,
          success: true,
          statusCode: r.value.statusCode,
        },
        "Push send succeeded",
      );
    } else {
      const err = r.reason as { statusCode?: number; message?: string };
      const statusCode = err?.statusCode;
      const errorMessage = err?.message ?? String(r.reason);

      logger.warn(
        {
          event: "push.send.result",
          userId,
          traceId,
          endpoint: sub.endpoint,
          success: false,
          statusCode,
          error: errorMessage,
        },
        "Push send failed",
      );

      // 404 / 410 — subscription is permanently gone; delete and log.
      if (statusCode === 410 || statusCode === 404) {
        logger.info(
          {
            event: "push.subscription.expired",
            userId,
            traceId,
            endpoint: sub.endpoint,
            statusCode,
          },
          "Push subscription expired — removing from DB",
        );
        await deleteSubscription(sub.endpoint).catch(() => { /* ignore */ });
      }
    }
  }
}

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  const subs = await db
    .select()
    .from(pushSubscriptionsTable)
    .where(eq(pushSubscriptionsTable.userId, userId));

  if (subs.length === 0) {
    logger.warn(
      {
        event: "push.send.result",
        userId,
        traceId: payload.traceId ?? null,
        success: false,
        error: "no_subscriptions",
        payloadType: payload.type ?? "posture",
      },
      "Push fire: no subscriptions found for user — notification not delivered",
    );
    return;
  }

  logger.info(
    {
      userId,
      traceId: payload.traceId ?? null,
      type: payload.type ?? "posture",
      subscriptionCount: subs.length,
    },
    "Push fire: sending to subscriptions",
  );
  await sendToSubscriptions(userId, subs, payload);
}
