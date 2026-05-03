import app from "./app";
import { logger } from "./lib/logger";
import { startFitbitPoller } from "./services/fitbitPoller";
import { postureOrchestrator } from "./orchestrators/posture.orchestrator";
import { cancelPushSchedule } from "./services/pushScheduler";
import { db, sessionsTable } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Startup cleanup — runs before reconcileTimersOnStartup.
 *
 * Terminates any open sessions that were created with an empty or null userId.
 * These are data-integrity relics from before Clerk authentication was wired
 * up. They must be closed before the reconciliation step so that
 * reconcileTimersOnStartup never restores a timer for userId="".
 *
 * Also explicitly cancels any in-process timer for the invalid userId so that
 * a running process that receives this cleanup call doesn't keep a stale timer
 * alive in memory.
 */
async function cleanupInvalidSessions(): Promise<void> {
  logger.info("startup.cleanup: scanning for sessions with invalid userId");

  let invalid: { id: number; userId: string }[];
  try {
    invalid = await db
      .select({ id: sessionsTable.id, userId: sessionsTable.userId })
      .from(sessionsTable)
      .where(
        and(
          isNull(sessionsTable.endedAt),
          or(
            eq(sessionsTable.userId, ""),
            isNull(sessionsTable.userId as Parameters<typeof isNull>[0]),
          ),
        ),
      );
  } catch (err) {
    logger.error({ err }, "startup.cleanup: failed to query invalid sessions — skipping");
    return;
  }

  if (invalid.length === 0) {
    logger.info("startup.cleanup: no invalid sessions found");
    return;
  }

  logger.warn(
    { count: invalid.length },
    "startup.cleanup: found open sessions with invalid userId — terminating",
  );

  const now = new Date();
  await Promise.allSettled(
    invalid.map(async ({ id, userId }) => {
      try {
        await db
          .update(sessionsTable)
          .set({ endedAt: now })
          .where(eq(sessionsTable.id, id));

        logger.info(
          { event: "cleanup.invalid_session_ended", sessionId: id, userId },
          "startup.cleanup: invalid session terminated",
        );

        // Cancel any in-process timer registered under this bad userId.
        // The orchestrator guard also blocks it, but being explicit here
        // ensures the timer map stays clean before reconciliation runs.
        cancelPushSchedule(userId ?? "", "manual");
      } catch (err) {
        logger.error({ err, sessionId: id }, "startup.cleanup: failed to terminate invalid session");
      }
    }),
  );

  logger.info("startup.cleanup: complete");
}

/**
 * Startup reconciliation — runs asynchronously after the server is ready.
 *
 * Queries every user with an open (active) session and calls
 * syncTimerWithSession for each one.  This restores in-memory push timers
 * that were lost when the process was restarted, ensuring no user goes
 * without their scheduled reminder after a deploy or crash.
 *
 * Does NOT block the server from accepting requests.
 */
async function reconcileTimersOnStartup(): Promise<void> {
  logger.info("startup.reconciliation: querying active sessions");

  let rows: { userId: string }[];
  try {
    rows = await db
      .selectDistinct({ userId: sessionsTable.userId })
      .from(sessionsTable)
      .where(isNull(sessionsTable.endedAt));
  } catch (err) {
    logger.error({ err }, "startup.reconciliation: failed to query active sessions — skipping");
    return;
  }

  if (rows.length === 0) {
    logger.info("startup.reconciliation: no active sessions found — nothing to restore");
    return;
  }

  logger.info(
    { userCount: rows.length },
    "startup.reconciliation: restoring timers for active-session users",
  );

  await Promise.allSettled(
    rows.map(async ({ userId }) => {
      try {
        await postureOrchestrator.syncTimerWithSession(userId);
        logger.info({ userId }, "startup.reconciliation: timer restored for user");
      } catch (err) {
        logger.error({ err, userId }, "startup.reconciliation: failed to restore timer for user");
      }
    }),
  );

  logger.info("startup.reconciliation: complete");
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  startFitbitPoller();

  logger.info(
    {
      event: "system.ready",
      features: [
        "startup_reconciliation",
        "self_healing",
        "orchestrator_locking",
        "debug_endpoint",
      ],
    },
    "System ready",
  );

  // Fire-and-forget startup sequence:
  //   1. cleanupInvalidSessions — closes any userId="" open sessions so they
  //      are never picked up by reconcileTimersOnStartup.
  //   2. reconcileTimersOnStartup — restores valid push timers from DB state.
  // Errors inside each step are caught internally so this never crashes.
  void cleanupInvalidSessions().then(() => reconcileTimersOnStartup());
});
