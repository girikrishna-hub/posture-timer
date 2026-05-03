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

const router: IRouter = Router();

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
 *   timerDetails: {
 *     [userId]: {
 *       activeTimer: {
 *         traceId:              string,
 *         mode:                 "sitting" | "standing",
 *         scheduledAt:          number,   // ms epoch
 *         nextTriggerAt:        number,   // ms epoch
 *         computedDelaySeconds: number,
 *         msUntilTrigger:       number    // negative if overdue
 *       } | null,
 *       recentEvents: TimerEvent[]        // last 5, oldest-first
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

  // Build per-user timer details for every user that appears in either list
  // or has any trace history.
  const relevantUsers = new Set([
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

  for (const userId of relevantUsers) {
    const state = getActiveTimerState(userId);
    timerDetails[userId] = {
      activeTimer: state
        ? { ...state, msUntilTrigger: state.nextTriggerAt - now }
        : null,
      recentEvents: getTimerHistory(userId),
    };
  }

  res.json({
    activeSessions: usersWithActiveSessions.length,
    activeTimers: getActiveTimerCount(),
    usersWithActiveSessions,
    usersWithActiveTimers,
    selfHealFailures: getSelfHealFailureCount(),
    timerDetails,
  });
});

export default router;
