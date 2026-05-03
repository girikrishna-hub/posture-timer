import { Router, type IRouter } from "express";
import { db, sessionsTable } from "@workspace/db";
import { isNull } from "drizzle-orm";
import { getActiveTimerCount, getActiveTimerUserIds } from "../services/pushScheduler";
import { getSelfHealFailureCount } from "../push/push.invariants";

const router: IRouter = Router();

/**
 * GET /debug/system-state
 *
 * Returns a snapshot of in-process and DB-backed system state for
 * observability and automated testing. No auth required — this endpoint is
 * internal-only and does not expose user data beyond userId strings.
 *
 * Response shape:
 * {
 *   activeSessions:          number,   // DB rows with endedAt IS NULL
 *   activeTimers:            number,   // in-process posture timer count
 *   usersWithActiveSessions: string[], // userIds from DB
 *   usersWithActiveTimers:   string[], // userIds from in-process map
 *   selfHealFailures:        number    // hard-failure count since start
 * }
 */
router.get("/debug/system-state", async (_req, res) => {
  const rows = await db
    .selectDistinct({ userId: sessionsTable.userId })
    .from(sessionsTable)
    .where(isNull(sessionsTable.endedAt));

  const usersWithActiveSessions = rows.map((r) => r.userId);
  const usersWithActiveTimers = getActiveTimerUserIds();

  res.json({
    activeSessions: usersWithActiveSessions.length,
    activeTimers: getActiveTimerCount(),
    usersWithActiveSessions,
    usersWithActiveTimers,
    selfHealFailures: getSelfHealFailureCount(),
  });
});

export default router;
