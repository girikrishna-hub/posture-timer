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
// Cleanup: once the stored promise for a user settles and no newer operation
// has taken its slot, the entry is removed from the Map to prevent unbounded
// growth.

const lockChain = new Map<string, Promise<void>>();

function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prior = lockChain.get(userId) ?? Promise.resolve();

  // Capture wall-clock time before we start waiting so we can measure how
  // long this call spent queued behind previous operations.
  const waitStart = Date.now();

  const result = prior.then(() => {
    const waitMs = Date.now() - waitStart;
    if (waitMs > 100) {
      logger.warn(
        { event: "lock.wait.slow", userId, waitMs },
        "posture.orchestrator: slow lock wait — serialised operations are backing up",
      );
    }
    return fn();
  });

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

// Minimum delay (seconds) used when rescheduling a missed timer event.
// Set explicitly here — we do NOT rely on pushScheduler's internal clamping.
const MISSED_EVENT_RESCHEDULE_DELAY_SECS = 5;

/**
 * Schedule exactly one posture timer for a sitting/standing session.
 * Generates a unique traceId for this scheduling cycle and threads it through
 * the scheduler so every subsequent event (fire, cancel, notify) is attributable.
 */
async function scheduleForSession(
  userId: string,
  mode: "sitting" | "standing",
  startedAt: Date,
): Promise<void> {
  const settings = await fetchSettings(userId);
  const rawElapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - startedAt.getTime()) / 1000),
  );

  const thresholdSeconds =
    mode === "sitting"
      ? settings.sittingAlertMinutes * 60
      : settings.standingMinMinutes * 60;

  let elapsedSeconds = rawElapsedSeconds;

  if (rawElapsedSeconds > thresholdSeconds) {
    const delaySeconds = rawElapsedSeconds - thresholdSeconds;

    logger.warn(
      {
        event: "timer.missed",
        userId,
        mode,
        elapsedSeconds: rawElapsedSeconds,
        thresholdSeconds,
        delaySeconds,
        reschedulingInSeconds: MISSED_EVENT_RESCHEDULE_DELAY_SECS,
      },
      "posture.orchestrator: missed timer event detected — rescheduling next cycle (no belated notification sent)",
    );

    // Compute elapsedSeconds that makes the scheduler fire in exactly
    // MISSED_EVENT_RESCHEDULE_DELAY_SECS seconds (not relying on clamping).
    elapsedSeconds = thresholdSeconds - MISSED_EVENT_RESCHEDULE_DELAY_SECS;
  }

  // Unique trace identifier for this scheduling cycle. Flows through
  // scheduling → firing → notification so every step is attributable.
  const traceId = `${userId}-${Date.now()}`;

  schedulePushNotifications(userId, { mode, elapsedSeconds, ...settings }, traceId);

  logger.info(
    { userId, mode, traceId, elapsedSeconds, rawElapsedSeconds },
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
  // Cancel with explicit reason so the trace log shows why it was cancelled.
  cancelPushSchedule(userId, "session_change");

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
  cancelPushSchedule(userId, "session_change");

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
      cancelPushSchedule(userId, "resync");
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
      cancelPushSchedule(userId, "resync");
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
    // Guard before taking the lock — an invalid userId must never reach the
    // timer scheduling logic or the per-user lock Map.
    if (!userId || userId.trim() === "") {
      logger.error(
        { event: "orchestrator.invalid_user", userId },
        "posture.orchestrator: invalid userId — ignoring onSessionStarted",
      );
      return Promise.resolve();
    }
    return withUserLock(userId, () => _onSessionStarted(userId, session));
  },

  /**
   * Called after a session has been ended (or an orphan was auto-closed).
   * Accepts null when used as a pure "cancel timer" operation with no
   * corresponding session object (e.g. DELETE /push/schedule).
   */
  onSessionEnded(userId: string, session: SessionDto | null): Promise<void> {
    if (!userId || userId.trim() === "") {
      logger.error(
        { event: "orchestrator.invalid_user", userId },
        "posture.orchestrator: invalid userId — ignoring onSessionEnded",
      );
      return Promise.resolve();
    }
    return withUserLock(userId, () => _onSessionEnded(userId, session));
  },

  /**
   * Reconcile timer state with whatever is currently in the DB.
   * Idempotent — safe to call any number of times.
   * Used at startup and by self-healing invariants.
   */
  syncTimerWithSession(userId: string): Promise<void> {
    if (!userId || userId.trim() === "") {
      logger.error(
        { event: "orchestrator.invalid_user", userId },
        "posture.orchestrator: invalid userId — ignoring syncTimerWithSession",
      );
      return Promise.resolve();
    }
    return withUserLock(userId, () => _syncTimerWithSession(userId));
  },
};
