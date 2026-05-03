import { Router, type IRouter } from "express";
import { db, sessionsTable } from "@workspace/db";
import { isNull } from "drizzle-orm";
import { getActiveTimerCount, getActiveTimerUserIds } from "../services/pushScheduler";
import { getSelfHealFailureCount } from "../push/push.invariants";
import {
  getActiveTimerState,
  getTimerHistory,
  getTrackedUserIds,
} from "../services/timerTrace";
import {
  recordPushReceived,
  recordNotificationShown,
  getPushReceived,
  getNotificationShown,
  getReceiptTrackedUserIds,
} from "../services/pushReceiptTrace";

const router: IRouter = Router();

// ─── Push receipt endpoints (called by service worker) ───────────────────────
//
// No auth — these beacons arrive from the service worker context where Clerk
// session tokens are not available. The userId is embedded in the encrypted
// push payload and echoed back here; for a debug endpoint this is acceptable.

/**
 * POST /debug/push-received
 *
 * Recorded when the service worker "push" event fires on the device.
 * Answers: "Did the device receive the push?"
 *
 * Body: { timestamp: number, payloadType: string, traceId: string, userId: string }
 */
router.post("/debug/push-received", (req, res) => {
  const { timestamp, payloadType, traceId, userId } = req.body as {
    timestamp?: number;
    payloadType?: string;
    traceId?: string;
    userId?: string;
  };

  if (!traceId || !userId || !payloadType) {
    return res.status(400).json({ error: "traceId, userId and payloadType are required" });
  }

  recordPushReceived(userId, traceId, payloadType, timestamp ?? Date.now());
  req.log.info(
    { event: "push-received", userId, traceId, payloadType },
    "SW push-received beacon recorded",
  );
  return res.json({ ok: true });
});

/**
 * POST /debug/notification-shown
 *
 * Recorded after showNotification() resolves in the service worker.
 * Answers: "Did the OS actually display the notification?"
 *
 * Body: { timestamp: number, payloadType: string, traceId: string, userId: string }
 */
router.post("/debug/notification-shown", (req, res) => {
  const { timestamp, payloadType, traceId, userId } = req.body as {
    timestamp?: number;
    payloadType?: string;
    traceId?: string;
    userId?: string;
  };

  if (!traceId || !userId || !payloadType) {
    return res.status(400).json({ error: "traceId, userId and payloadType are required" });
  }

  recordNotificationShown(userId, traceId, payloadType, timestamp ?? Date.now());
  req.log.info(
    { event: "notification-shown", userId, traceId, payloadType },
    "SW notification-shown beacon recorded",
  );
  return res.json({ ok: true });
});

// ─── System state snapshot ────────────────────────────────────────────────────

/**
 * GET /debug/system-state
 *
 * Returns a snapshot of in-process and DB-backed system state for
 * observability and automated testing. No auth required — internal only.
 *
 * Response shape:
 * {
 *   activeSessions:          number,
 *   activeTimers:            number,
 *   usersWithActiveSessions: string[],
 *   usersWithActiveTimers:   string[],
 *   selfHealFailures:        number,
 *
 *   timerDetails: {
 *     [userId]: {
 *       activeTimer: {
 *         traceId, mode, scheduledAt, nextTriggerAt,
 *         computedDelaySeconds, msUntilTrigger
 *       } | null,
 *       recentEvents: TimerEvent[]    // last 5, oldest-first
 *     }
 *   },
 *
 *   pushReceipts: {
 *     [userId]: {
 *       received:  PushReceiptEvent[],  // last 20 push-received beacons
 *       shown:     PushReceiptEvent[]   // last 20 notification-shown beacons
 *     }
 *   }
 * }
 */
router.get("/debug/system-state", async (_req, res) => {
  const rows = await db
    .selectDistinct({ userId: sessionsTable.userId })
    .from(sessionsTable)
    .where(isNull(sessionsTable.endedAt));

  const usersWithActiveSessions = rows.map((r) => r.userId);
  const usersWithActiveTimers = getActiveTimerUserIds();

  // ── Timer details ─────────────────────────────────────────────────────────
  const timerUsers = new Set([
    ...usersWithActiveSessions,
    ...usersWithActiveTimers,
    ...getTrackedUserIds(),
  ]);

  const now = Date.now();
  const timerDetails: Record<
    string,
    {
      activeTimer: {
        traceId: string;
        mode: string;
        scheduledAt: number;
        nextTriggerAt: number;
        computedDelaySeconds: number;
        msUntilTrigger: number;
      } | null;
      recentEvents: ReturnType<typeof getTimerHistory>;
    }
  > = {};

  for (const userId of timerUsers) {
    const state = getActiveTimerState(userId);
    timerDetails[userId] = {
      activeTimer: state
        ? { ...state, msUntilTrigger: state.nextTriggerAt - now }
        : null,
      recentEvents: getTimerHistory(userId),
    };
  }

  // ── Push receipt details ──────────────────────────────────────────────────
  const receiptUsers = new Set([
    ...timerUsers,
    ...getReceiptTrackedUserIds(),
  ]);

  const pushReceipts: Record<
    string,
    {
      received: ReturnType<typeof getPushReceived>;
      shown: ReturnType<typeof getNotificationShown>;
    }
  > = {};

  for (const userId of receiptUsers) {
    pushReceipts[userId] = {
      received: getPushReceived(userId),
      shown: getNotificationShown(userId),
    };
  }

  res.json({
    activeSessions: usersWithActiveSessions.length,
    activeTimers: getActiveTimerCount(),
    usersWithActiveSessions,
    usersWithActiveTimers,
    selfHealFailures: getSelfHealFailureCount(),
    timerDetails,
    pushReceipts,
  });
});

export default router;
