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
// Each userId maps to a void promise that settles when the current operation
// finishes. New callers chain on that promise — they wait their turn.
// The stored promise always resolves (errors are swallowed into void) so a
// failing operation never blocks subsequent ones for the same user.
//
// Cleanup: once the stored promise for a user settles and no new operation has
// taken its slot, the entry is removed from the Map to prevent unbounded growth.

const lockChain = new Map<string, Promise<void>>();

function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prior = lockChain.get(userId) ?? Promise.resolve();
  const result = prior.then(() => fn());

  // voidResult always resolves — safe to chain future operations on.
  const voidResult: Promise<void> = result.then(() => {}, () => {});
  lockChain.set(userId, voidResult);

  // Cleanup: remove map entry once this operation is done and nothing newer
  // has replaced it. Prevents unbounded Map growth for long-running servers.
  void voidResult.then(() => {
    if (lockChain.get(userId) === voidResult) lockChain.delete(userId);
  });

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

/**
 * Schedule exactly one posture timer for a sitting/standing session.
 *
 * Also detects missed timer events: if the session has been running longer
 * than the initial alert threshold (e.g. sitting for 60 min when alert is
 * set to 45 min), the alert window has already passed. Rather than spamming
 * the user with a belated notification, the scheduler is called with the real
 * elapsedSeconds — pushScheduler clamps any negative delay to 5 s so the
 * next cycle fires quickly. The missed event is logged for observability.
 */
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

  // Missed-event detection: check whether the first alert threshold has passed.
  const thresholdSeconds =
    mode === "sitting"
      ? settings.sittingAlertMinutes * 60
      : settings.standingMinMinutes * 60;

  if (elapsedSeconds > thresholdSeconds) {
    const delaySeconds = elapsedSeconds - thresholdSeconds;
    logger.warn(
      {
        event: "timer.missed",
        userId,
        mode,
        elapsedSeconds,
        thresholdSeconds,
        delaySeconds,
      },
      "posture.orchestrator: missed timer event detected — rescheduling next cycle (no belated notification sent)",
    );
  }

  // schedulePushNotifications clamps nextDelaySecs ≤ 0 to 5 s, so passing a
  // large elapsedSeconds is safe — it just fires the next cycle very soon.
  schedulePushNotifications(userId, { mode, elapsedSeconds, ...settings });

  logger.info(
    { userId, mode, elapsedSeconds },
    "posture.orchestrator: timer scheduled",
  );
}

// ─── Implementation (unlocked) ───────────────────────────────────────────────
// These functions contain the real logic. They are called from the public API
// wrappers which hold the per-user lock before invoking them.
//
// IMPORTANT: _syncTimerWithSession is passed as the healFn to
// ensureSingleActiveTimer. It must be the UNLOCKED variant so calling it from
// inside the lock does not deadlock.

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
      logger.info(
        { userId },
        "posture.orchestrator: syncTimerWithSession — no active session, no timer needed",
      );
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
