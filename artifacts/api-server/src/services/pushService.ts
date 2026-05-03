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
  subs: { endpoint: string; p256dh: string; auth: string }[],
  payload: PushPayload,
): Promise<void> {
  const results = await Promise.allSettled(
    subs.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      ),
    ),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      const err = r.reason as { statusCode?: number };
      logger.warn({ endpoint: subs[i]?.endpoint, statusCode: err?.statusCode }, "Push failed");
      const ep = subs[i]?.endpoint;
      if (ep && (err?.statusCode === 410 || err?.statusCode === 404)) {
        await deleteSubscription(ep).catch(() => { /* ignore */ });
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
    logger.warn({ userId, type: payload.type ?? "posture" }, "Push fire: no subscriptions found for user — notification not delivered");
    return;
  }

  logger.info({ userId, type: payload.type ?? "posture", subscriptionCount: subs.length }, "Push fire: sending to subscriptions");
  await sendToSubscriptions(subs, payload);
}
