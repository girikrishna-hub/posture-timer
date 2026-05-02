import webpush from "web-push";
import { db, pushSubscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const vapidPublicKey = process.env["VAPID_PUBLIC_KEY"] ?? "";
const vapidPrivateKey = process.env["VAPID_PRIVATE_KEY"] ?? "";
const vapidSubject = process.env["VAPID_SUBJECT"] ?? "mailto:admin@example.com";

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

export { vapidPublicKey };

export interface PushPayload {
  title: string;
  body: string;
}

export async function saveSubscription(
  endpoint: string,
  p256dh: string,
  auth: string,
): Promise<void> {
  await db
    .insert(pushSubscriptionsTable)
    .values({ endpoint, p256dh, auth })
    .onConflictDoUpdate({
      target: pushSubscriptionsTable.endpoint,
      set: { p256dh, auth },
    });
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  await db
    .delete(pushSubscriptionsTable)
    .where(eq(pushSubscriptionsTable.endpoint, endpoint));
}

export async function sendPushToAll(payload: PushPayload): Promise<void> {
  const subs = await db.select().from(pushSubscriptionsTable);

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
      logger.warn({ endpoint: subs[i].endpoint, statusCode: err?.statusCode }, "Push failed");
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        await deleteSubscription(subs[i].endpoint).catch(() => { /* ignore */ });
      }
    }
  }
}
