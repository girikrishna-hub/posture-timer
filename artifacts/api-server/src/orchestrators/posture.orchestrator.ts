/**
 * Posture Orchestrator
 *
 * Single authority on WHEN to schedule or cancel posture push timers.
 * All public methods are serialised per-user via an in-memory promise-chain
 * lock so that rapid concurrent calls (e.g. two POSTs racing) produce exactly
 * one consistent outcome without duplicates.
 *
 * Existing API endpoints (POST /push/schedule, DELETE /push/schedule) remain
 * externally unchanged; internally they now route through this orchestrator.
 */

import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import {
  schedulePushNotifications,
  cancelPushSchedule,
  hasActivePostureTimer,
} from "../services/pushScheduler";
import { sessionRepository } from "../sessions/session.repository";
import { ensureSingleActiveTimer } from "../push/push.invariants";
import { logger } from "../lib/logger";
import type { SessionDto } from "../sessions/session.dto";

// ─── Per-user lock ───────────────────────────────────────────────────────────
//
// Each userId maps to a promise that settles when the current operation for
// that user finishes. New operations chain on the existing promise, so they
// wait their turn. The stored promise always resolves (never rejects) so
// upstream rejections do not block the queue.

const lockChain = new Map<string, Promise<void>>();

function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prior = lockChain.get(userId) ?? Promise.resolve();
  const result = prior.then(() => fn());
  // Store a version that always resolves so future waiters are never blocked
  // by a rejection from the current operation.
  lockChain.set(userId, result.then(() => {}, () => {}));
  return result;
}

// ─── Settings fetch ──────────────────────────────────────────────────────────

interface PostureSettings {
  sittingAlertMinutes: number;
  standingMinMinutes: number;
  standingMaxMinutes: number;
  reminderIntervalMinutes: number;
  remindersCount: number;
}

const DEFAULTS: PostureSettings = {
  sittingAlertMinutes: 45,
  standingMinMinutes: 10,
  standingMaxMinutes: 15,
  reminderIntervalMinutes: 1,
  remindersCount: 3,
};

async function fetchSettings(userId: string): Promise<PostureSettings> {
  const [row] = await db
    .select({
      sittingAlertMinutes: settingsTable.sittingAlertMinutes,
      standingMinMinutes: settingsTable.standingMinMinutes,
      standingMaxMinutes: settingsTable.standingMaxMinutes,
      reminderIntervalMinutes: settingsTable.reminderIntervalMinutes,
      remindersCount: settingsTable.remindersCount,
    })
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId))
    .limit(1);
  return row ?? DEFAULTS;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function scheduleForSession(
  userId: string,
  mode: "sitting" | "standing",
  startedAt: Date,
): Promise<void> {
  const settings = await fetchSettings(userId);
  const elapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - startedAt.getTime()) / 1000),
  );

  schedulePushNotifications(userId, { mode, elapsedSeconds, ...settings });

  logger.info(
    { userId, mode, elapsedSeconds },
    "posture.orchestrator: timer scheduled",
  );
}

// ─── Implementation (unlocked) ───────────────────────────────────────────────
// These functions contain the real logic. They are wrapped by the public API
// so the lock is acquired before any of this runs.

async function _onSessionStarted(userId: string, session: SessionDto): Promise<void> {
  const hadTimer = hasActivePostureTimer(userId);
  cancelPushSchedule(userId);

  if (hadTimer) {
    logger.info(
      { userId, newMode: session.mode },
      "posture.orchestrator: existing timer cancelled before scheduling replacement",
    );
  }

  if (session.mode === "sitting" || session.mode === "standing") {
    await scheduleForSession(userId, session.mode, new Date(session.startedAt));
  } else {
    logger.info(
      { userId, mode: session.mode },
      "posture.orchestrator: mode does not use push timer — no timer scheduled",
    );
  }

  await ensureSingleActiveTimer(userId, (id) => _syncTimerWithSession(id));
}

async function _onSessionEnded(userId: string, session: SessionDto | null): Promise<void> {
  const hadTimer = hasActivePostureTimer(userId);
  cancelPushSchedule(userId);

  if (hadTimer) {
    logger.info(
      { userId, sessionId: session?.id ?? null, mode: session?.mode ?? null },
      "posture.orchestrator: timer cancelled on session end",
    );
  } else {
    logger.info(
      { userId, sessionId: session?.id ?? null },
      "posture.orchestrator: session ended — no timer was active",
    );
  }

  await ensureSingleActiveTimer(userId, (id) => _syncTimerWithSession(id));
}

async function _syncTimerWithSession(userId: string): Promise<void> {
  const activeSession = await sessionRepository.findActiveSession(userId);

  if (!activeSession) {
    const hadTimer = hasActivePostureTimer(userId);
    if (hadTimer) {
      cancelPushSchedule(userId);
      logger.warn(
        { userId },
        "posture.orchestrator: syncTimerWithSession — cancelled orphan timer (no active session)",
      );
    } else {
      logger.info({ userId }, "posture.orchestrator: syncTimerWithSession — no active session, no timer needed");
    }
    await ensureSingleActiveTimer(userId, (id) => _syncTimerWithSession(id));
    return;
  }

  const mode = activeSession.mode;

  if (mode === "sitting" || mode === "standing") {
    logger.info(
      { userId, mode },
      "posture.orchestrator: syncTimerWithSession — rescheduling timer from current session",
    );
    await scheduleForSession(userId, mode, activeSession.startedAt);
  } else {
    const hadTimer = hasActivePostureTimer(userId);
    if (hadTimer) {
      cancelPushSchedule(userId);
      logger.warn(
        { userId, mode },
        "posture.orchestrator: syncTimerWithSession — cancelled stale timer for non-posture session",
      );
    }
  }

  await ensureSingleActiveTimer(userId, (id) => _syncTimerWithSession(id));
}

// ─── Public API (lock-wrapped) ───────────────────────────────────────────────

export const postureOrchestrator = {
  /**
   * Called after a new session has been persisted to the DB.
   * Serialised per-user — safe to call concurrently.
   */
  onSessionStarted(userId: string, session: SessionDto): Promise<void> {
    return withUserLock(userId, () => _onSessionStarted(userId, session));
  },

  /**
   * Called after a session has been ended (or an orphan was auto-closed).
   * Accepts null when used as a pure "cancel timer" operation with no
   * corresponding session object (e.g. DELETE /push/schedule).
   */
  onSessionEnded(userId: string, session: SessionDto | null): Promise<void> {
    return withUserLock(userId, () => _onSessionEnded(userId, session));
  },

  /**
   * Reconcile timer state with whatever is currently in the DB.
   * Idempotent — safe to call any number of times.
   * Used at startup and by self-healing invariants.
   */
  syncTimerWithSession(userId: string): Promise<void> {
    return withUserLock(userId, () => _syncTimerWithSession(userId));
  },
};
