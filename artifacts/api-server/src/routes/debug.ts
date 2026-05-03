import { generateKeyPairSync, randomBytes } from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, sessionsTable, pushSubscriptionsTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import { getActiveTimerCount, getActiveTimerUserIds, cancelAllPostureTimers } from "../services/pushScheduler";
import { getSelfHealFailureCount } from "../push/push.invariants";
import { getRescheduleLoopCount, getActiveTimerState, getTimerHistory, getTrackedUserIds } from "../services/timerTrace";
import { getInvalidUserEventCount, postureOrchestrator } from "../orchestrators/posture.orchestrator";
import {
  recordPushReceived,
  recordNotificationShown,
  getPushReceived,
  getNotificationShown,
  getReceiptTrackedUserIds,
} from "../services/pushReceiptTrace";
import { logger } from "../lib/logger";

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

// ─── Generate test subscription keys ─────────────────────────────────────────
//
// Returns a valid ECDH P-256 key pair + 16-byte auth secret encoded as
// base64url strings — the exact format the Web Push spec and web-push library
// expect for subscription.keys.p256dh / subscription.keys.auth.
//
// Used by subscriptionFlow.ts so it can register a fake subscription with
// keys that web-push can actually encrypt to (and the fake endpoint can
// then respond 410 to trigger the auto-delete cleanup path).

router.get("/debug/test-subscription-keys", (_req, res) => {
  // Use JWK export to safely extract the raw X/Y coordinates without
  // depending on SPKI DER structure assumptions that may vary by Node version.
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const xBuf = Buffer.from(jwk.x, "base64url");
  const yBuf = Buffer.from(jwk.y, "base64url");

  // Uncompressed P-256 point: 0x04 || X (32 bytes) || Y (32 bytes) = 65 bytes total.
  const p256dhBuf = Buffer.concat([Buffer.from([0x04]), xBuf, yBuf]);
  const p256dh = p256dhBuf.toString("base64url");

  // auth is 16 cryptographically-random bytes
  const auth = randomBytes(16).toString("base64url");

  // Debug: include decoded lengths so the test runner can verify correctness.
  const p256dhDecodedLen = Buffer.from(p256dh, "base64url").length;
  const authDecodedLen = Buffer.from(auth, "base64url").length;

  // Return an HTTPS base URL the test runner can use as the fake push endpoint.
  // web-push hardcodes https.request regardless of the endpoint URL scheme, so
  // the endpoint MUST be reachable over real HTTPS.
  // - localhost:80 is the mTLS reverse proxy — web-push's default TLS agent
  //   cannot negotiate mTLS, so it fails with an EPROTO SSL error.
  // - localhost:<PORT> is plain HTTP — https.request tries TLS and also fails.
  // The external REPLIT_DEV_DOMAIN is a standard HTTPS endpoint; the Replit
  // proxy terminates TLS and forwards to the Express server over plain HTTP.
  const devDomain = process.env["REPLIT_DEV_DOMAIN"];
  const fakeEndpointBase = devDomain
    ? `https://${devDomain}/api`
    : `http://localhost:${process.env["PORT"] ?? "8080"}/api`;

  res.json({ p256dh, auth, p256dhDecodedLen, authDecodedLen, fakeEndpointBase });
});

// ─── Fake push endpoint (subscription lifecycle testing) ──────────────────────
//
// Accepts any POST (web-push protocol or plain JSON) and replies with the
// HTTP status code given in the `?status=` query parameter (default 201).
// Lets subscriptionFlow.ts register a subscription pointing at this URL so
// the real web-push send will receive a 410 response and trigger the
// automatic subscription-expiry cleanup path.
//
// No auth — this is a dev/test-only stub that never delivers a real notification.

router.post("/debug/fake-push-endpoint", (req: Request, res: Response) => {
  const raw = (req.query["status"] as string | undefined) ?? "201";
  const statusCode = Number.isFinite(parseInt(raw, 10)) ? parseInt(raw, 10) : 201;
  req.log.info(
    { event: "fake.push.endpoint", statusCode },
    "fake-push-endpoint: responding with configured status code",
  );
  res.status(statusCode).end();
});

// ─── Simulate restart (dirty-restart testing) ─────────────────────────────────
//
// Wipes ALL in-memory posture timers (simulating a process restart that lost
// in-process state) and then runs the startup reconciliation logic for every
// user that currently has an open session in the DB.
//
// This lets restartFlow.ts prove that timers are correctly restored after a
// crash without having to actually kill the process.
//
// Returns { cancelled: string[], reconciled: string[] }.

router.post("/debug/simulate-restart", async (_req, res) => {
  // 1. Cancel all in-flight timers (simulate memory wipe)
  const cancelled = cancelAllPostureTimers();

  logger.info(
    { event: "simulate.restart", cancelledCount: cancelled.length, cancelled },
    "debug: simulate-restart — cancelled all posture timers",
  );

  // 2. Query users with active sessions (same query as startup reconciliation)
  const rows = await db
    .selectDistinct({ userId: sessionsTable.userId })
    .from(sessionsTable)
    .where(isNull(sessionsTable.endedAt));

  const reconciled: string[] = [];

  await Promise.allSettled(
    rows.map(async ({ userId }) => {
      try {
        await postureOrchestrator.syncTimerWithSession(userId);
        reconciled.push(userId);
        logger.info({ userId }, "debug: simulate-restart — timer restored for user");
      } catch (err) {
        logger.error({ err, userId }, "debug: simulate-restart — failed to restore timer");
      }
    }),
  );

  logger.info(
    { event: "simulate.restart.complete", reconciledCount: reconciled.length },
    "debug: simulate-restart complete",
  );

  res.json({ ok: true, cancelled, reconciled });
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
 *   selfHealFailures:        number,     // lifetime; never resets
 *   rescheduleLoopCount:     number,     // lifetime; never resets
 *   invalidUserEventCount:   number,     // lifetime; never resets
 *
 *   subscriptionCounts: {
 *     [userId]: number                  // push_subscriptions rows per user
 *   },
 *
 *   timerDetails: {
 *     [userId]: {
 *       activeTimer: { traceId, mode, scheduledAt, nextTriggerAt,
 *                      computedDelaySeconds, msUntilTrigger } | null,
 *       recentEvents: TimerEvent[]      // last 5, oldest-first
 *     }
 *   },
 *
 *   pushReceipts: {
 *     [userId]: {
 *       received: PushReceiptEvent[],   // last 20 push-received beacons
 *       shown:    PushReceiptEvent[]    // last 20 notification-shown beacons
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

  // ── Subscription counts per user ─────────────────────────────────────────
  // Query only for users we're already tracking so we don't do a full table scan.
  const subUsers = Array.from(timerUsers);
  const subscriptionCounts: Record<string, number> = {};

  for (const userId of subUsers) {
    const userSubs = await db
      .select({ id: pushSubscriptionsTable.id })
      .from(pushSubscriptionsTable)
      .where(eq(pushSubscriptionsTable.userId, userId));
    subscriptionCounts[userId] = userSubs.length;
  }

  res.json({
    activeSessions: usersWithActiveSessions.length,
    activeTimers: getActiveTimerCount(),
    usersWithActiveSessions,
    usersWithActiveTimers,
    selfHealFailures: getSelfHealFailureCount(),
    rescheduleLoopCount: getRescheduleLoopCount(),
    invalidUserEventCount: getInvalidUserEventCount(),
    subscriptionCounts,
    timerDetails,
    pushReceipts,
  });
});

export default router;
