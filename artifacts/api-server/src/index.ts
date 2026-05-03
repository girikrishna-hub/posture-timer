import app from "./app";
import { logger } from "./lib/logger";
import { startFitbitPoller } from "./services/fitbitPoller";
import { postureOrchestrator } from "./orchestrators/posture.orchestrator";
import { db, sessionsTable } from "@workspace/db";
import { isNull } from "drizzle-orm";

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

  // Fire-and-forget: restore push timers from DB state.
  // Errors are caught inside reconcileTimersOnStartup so this never crashes.
  void reconcileTimersOnStartup();
});
