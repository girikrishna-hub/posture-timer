/**
 * Posture Orchestrator
 *
 * Keeps push timer state consistent with session state.
 * This module is the single authority on WHEN to schedule or cancel posture
 * push timers in response to session lifecycle events.
 *
 * Existing API endpoints (POST /push/schedule, DELETE /push/schedule) continue
 * to work unchanged — they call pushScheduler directly. The orchestrator simply
 * ensures the scheduler is also driven by session state automatically.
 */

import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import {
  schedulePushNotifications,
  cancelPushSchedule,
  hasActivePostureTimer,
} from "../services/pushScheduler";
import { sessionRepository } from "../sessions/session.repository";
import { assertSingleActiveTimer } from "../push/push.invariants";
import { logger } from "../lib/logger";
import type { SessionDto } from "../sessions/session.dto";

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
 * Internally idempotent: the scheduler clears any existing timer before
 * setting a new one, so calling this multiple times is safe.
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

  schedulePushNotifications(userId, {
    mode,
    elapsedSeconds,
    ...settings,
  });

  logger.info(
    { userId, mode, elapsedSeconds },
    "posture.orchestrator: timer scheduled",
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

export const postureOrchestrator = {
  /**
   * Called after a new session has been persisted to the DB.
   *
   * Behaviour:
   *   - Always cancels any existing timer first (prevents duplicates even
   *     when called multiple times for the same session).
   *   - Schedules a new timer only for sitting / standing modes.
   *   - Logs what it does at every step.
   */
  async onSessionStarted(userId: string, session: SessionDto): Promise<void> {
    const hadTimer = hasActivePostureTimer(userId);

    // Cancel whatever was running. Safe no-op if nothing was scheduled.
    cancelPushSchedule(userId);

    if (hadTimer) {
      logger.info(
        { userId, previousTimer: true, newMode: session.mode },
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

    await assertSingleActiveTimer(userId);
  },

  /**
   * Called after a session has been ended (or an orphan has been auto-closed).
   *
   * Behaviour:
   *   - Cancels the posture timer.
   *   - Safe no-op if no timer was running.
   */
  async onSessionEnded(userId: string, session: SessionDto): Promise<void> {
    const hadTimer = hasActivePostureTimer(userId);
    cancelPushSchedule(userId);

    if (hadTimer) {
      logger.info(
        { userId, sessionId: session.id, mode: session.mode },
        "posture.orchestrator: timer cancelled on session end",
      );
    } else {
      logger.info(
        { userId, sessionId: session.id, mode: session.mode },
        "posture.orchestrator: session ended — no timer was active (already cancelled or mode had no timer)",
      );
    }

    await assertSingleActiveTimer(userId);
  },

  /**
   * Repair helper — call this to bring timer state into sync with the current
   * active session (e.g. after server restart or recovery).
   *
   *   • No active session          → ensure no timer exists
   *   • sitting / standing session → ensure exactly one correct timer exists
   *   • resting / walking session  → ensure no timer exists
   */
  async syncTimerWithSession(userId: string): Promise<void> {
    const activeSession = await sessionRepository.findActiveSession(userId);

    if (!activeSession) {
      const hadTimer = hasActivePostureTimer(userId);
      if (hadTimer) {
        cancelPushSchedule(userId);
        logger.warn(
          { userId },
          "posture.orchestrator: syncTimerWithSession — cancelled orphan timer (no active session)",
        );
      }
      await assertSingleActiveTimer(userId);
      return;
    }

    const mode = activeSession.mode;

    if (mode === "sitting" || mode === "standing") {
      // Always reschedule: elapsedSeconds is recomputed from real wall-clock
      // time, so the timer is correct whether or not one already existed.
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

    await assertSingleActiveTimer(userId);
  },
};
