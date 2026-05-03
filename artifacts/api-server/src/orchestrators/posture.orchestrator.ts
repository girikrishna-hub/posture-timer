/**
 * Posture Orchestrator
 *
 * Single authority on WHEN to schedule or cancel posture push timers AND on
 * creating new sessions under the per-user lock.
 *
 * Moving session creation here (instead of session.service) ensures that the
 * find-orphan → close-orphan → create-new-session sequence is fully serialised
 * per-user. Without the lock around the DB writes, three concurrent POST
 * /sessions requests can all read "no active session" simultaneously, each
 * create a row, and produce overlapping sessions that violate invariant 3.
 *
 * All public methods are serialised per-user via an in-memory promise-chain
 * lock so that rapid concurrent calls (e.g. two POSTs racing) produce exactly
 * one consistent outcome without duplicates.
 */

import { eq } from "drizzle-orm";
import { db, settingsTable, type Session } from "@workspace/db";
import {
  schedulePushNotifications,
  cancelPushSchedule,
  hasActivePostureTimer,
} from "../services/pushScheduler";
import { sessionRepository } from "../sessions/session.repository";
import { assertSessionInvariants } from "../sessions/session.invariants";
import { ensureSingleActiveTimer } from "../push/push.invariants";
import { assertValidUserId } from "../lib/assertValidUserId";
import { logger } from "../lib/logger";
import type { StartSessionDto, SessionDto } from "../sessions/session.dto";

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

// ─── Session DTO helpers ─────────────────────────────────────────────────────
//
// Duplicated here (rather than imported from session.service) to avoid a
// circular dependency: session.service → orchestrator → session.service.
// These are pure transformations with no side-effects.

function classifyRest(startedAt: Date, endedAt: Date): "nap" | "sleep" | null {
  const durationHours = (endedAt.getTime() - startedAt.getTime()) / (1000 * 60 * 60);
  const startHour = startedAt.getHours();
  const endHour = endedAt.getHours();
  const isNighttime = startHour >= 21 || startHour < 8 || endHour >= 21 || endHour < 8;
  if (durationHours >= 3 || isNighttime) return "sleep";
  if (startHour >= 11 && startHour < 18) return "nap";
  return null;
}

function toDto(session: Session): SessionDto {
  return {
    id: session.id,
    mode: session.mode as SessionDto["mode"],
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt ? session.endedAt.toISOString() : null,
    durationSeconds: session.durationSeconds ?? null,
    restType: (session.restType as SessionDto["restType"]) ?? null,
  };
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

/**
 * Create a new session under the per-user lock.
 *
 * By running the full find-orphan → close-orphan → create sequence inside the
 * lock we guarantee that no two concurrent POST /sessions requests can both
 * observe "no active session" and both insert rows at the same instant — which
 * would produce overlapping session records that violate DB invariant 3.
 */
async function _startSession(userId: string, dto: StartSessionDto): Promise<SessionDto> {
  // Close any orphaned active session first
  const existing = await sessionRepository.findActiveSession(userId);

  if (existing) {
    logger.warn(
      { userId, orphanedSessionId: existing.id },
      "posture.orchestrator: auto-closing orphaned active session before creating new one",
    );
    const closeAt = dto.startedAt ?? new Date();
    const durationSeconds = Math.max(
      0,
      Math.round((closeAt.getTime() - existing.startedAt.getTime()) / 1000),
    );
    let restType = existing.restType;
    if (existing.mode === "resting" && !existing.restType) {
      restType = classifyRest(existing.startedAt, closeAt);
    }
    await sessionRepository.endSession(existing.id, userId, {
      endedAt: closeAt,
      durationSeconds,
      restType,
    });
    // Cancel any timer the orphaned session may have left running.
    await _onSessionEnded(userId, toDto({ ...existing, endedAt: closeAt, durationSeconds, restType: restType ?? null }));
  }

  const session = await sessionRepository.createSession({
    userId,
    mode: dto.mode as "sitting" | "standing" | "resting" | "walking",
    startedAt: dto.startedAt ?? new Date(),
    restType: dto.restType,
  });

  logger.info(
    { userId, sessionId: session.id, mode: session.mode },
    "posture.orchestrator: session created",
  );

  await assertSessionInvariants(userId);
  await _onSessionStarted(userId, toDto(session));

  return toDto(session);
}

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
   * Start a new session for the user under the per-user lock.
   *
   * Moving session creation into the orchestrator (and therefore inside the
   * lock) prevents the race condition where concurrent POST /sessions requests
   * each observe "no active session" and both create DB rows that overlap.
   *
   * Previously this logic lived in session.service.startSession, which called
   * orchestrator.onSessionStarted only after the DB write had already raced.
   */
  startSession(userId: string, dto: StartSessionDto): Promise<SessionDto> {
    assertValidUserId(userId);
    return withUserLock(userId, () => _startSession(userId, dto));
  },

  /**
   * Called after a new session has been persisted to the DB.
   * Serialised per-user — safe to call concurrently.
   *
   * Retained for external callers that create sessions via other paths
   * (e.g. DB-seeded sessions, scripts, tests). Normal app flow should use
   * startSession() so the DB write is also inside the lock.
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
