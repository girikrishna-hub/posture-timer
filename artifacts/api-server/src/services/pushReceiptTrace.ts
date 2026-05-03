/**
 * Push Receipt Trace
 *
 * In-memory ring buffer for client-side push receipt events reported by the
 * service worker via POST /debug/push-received and /debug/notification-shown.
 *
 * Completely separate from timerTrace — this covers the device side of the
 * push pipeline, whereas timerTrace covers the server side.
 */

export type ReceiptEventType = "push-received" | "notification-shown";

export interface PushReceiptEvent {
  event: ReceiptEventType;
  /** Client-reported timestamp (ms epoch, from the device clock). */
  clientTimestamp: number;
  /** Server-recorded timestamp (ms epoch, when the beacon arrived). */
  serverTimestamp: number;
  traceId: string;
  payloadType: string;
}

const MAX_EVENTS_PER_USER = 20;

const pushReceivedHistory = new Map<string, PushReceiptEvent[]>();
const notificationShownHistory = new Map<string, PushReceiptEvent[]>();

function append(
  map: Map<string, PushReceiptEvent[]>,
  userId: string,
  event: PushReceiptEvent,
): void {
  const arr = map.get(userId) ?? [];
  arr.push(event);
  if (arr.length > MAX_EVENTS_PER_USER) arr.shift();
  map.set(userId, arr);
}

export function recordPushReceived(
  userId: string,
  traceId: string,
  payloadType: string,
  clientTimestamp: number,
): void {
  append(pushReceivedHistory, userId, {
    event: "push-received",
    clientTimestamp,
    serverTimestamp: Date.now(),
    traceId,
    payloadType,
  });
}

export function recordNotificationShown(
  userId: string,
  traceId: string,
  payloadType: string,
  clientTimestamp: number,
): void {
  append(notificationShownHistory, userId, {
    event: "notification-shown",
    clientTimestamp,
    serverTimestamp: Date.now(),
    traceId,
    payloadType,
  });
}

export function getPushReceived(userId: string): PushReceiptEvent[] {
  return pushReceivedHistory.get(userId) ?? [];
}

export function getNotificationShown(userId: string): PushReceiptEvent[] {
  return notificationShownHistory.get(userId) ?? [];
}

/** All userIds that have any receipt history. */
export function getReceiptTrackedUserIds(): string[] {
  return Array.from(
    new Set([...pushReceivedHistory.keys(), ...notificationShownHistory.keys()]),
  );
}
