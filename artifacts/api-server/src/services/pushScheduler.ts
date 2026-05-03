import { sendPushToUser } from "./pushService";
import { logger } from "../lib/logger";
import {
  recordScheduled,
  recordCancelled,
  recordFired,
  recordNotificationAttempt,
  recordNotificationSent,
  LOOP_THRESHOLD,
  LOOP_WINDOW_MS,
} from "./timerTrace";
import type { CancelReason } from "./timerTrace";

interface ScheduleParams {
  mode: "sitting" | "standing";
  elapsedSeconds: number;
  sittingAlertMinutes: number;
  standingMinMinutes: number;
  standingMaxMinutes: number;
  reminderIntervalMinutes: number;
  remindersCount: number;
}

// Per-user timer map — stores the handle AND the trace metadata so we can
// attribute cancellations and drift measurements back to a specific schedule.
interface TimerEntry {
  handle: ReturnType<typeof setTimeout>;
  traceId: string;
  nextTriggerAt: number;
}

const activeTimers = new Map<string, TimerEntry>();

function clearActive(userId: string, reason: CancelReason): void {
  const entry = activeTimers.get(userId);
  if (entry === undefined) return;

  clearTimeout(entry.handle);
  activeTimers.delete(userId);

  recordCancelled(userId, entry.traceId, reason);
  logger.info(
    { event: "timer.cancelled", traceId: entry.traceId, userId, reason },
    "Posture timer cancelled",
  );
}

function scheduleNext(
  userId: string,
  params: ScheduleParams,
  currentMode: "sitting" | "standing",
  remindersFired: number,
  traceId: string,
): void {
  // Always clear the previous entry before setting a new one.
  // When this is called from a natural timer callback the entry is already
  // deleted (callback removes it first) so this is a no-op there.
  clearActive(userId, "resync");

  const {
    sittingAlertMinutes,
    standingMinMinutes,
    standingMaxMinutes,
    reminderIntervalMinutes,
    remindersCount,
  } = params;

  let nextDelaySecs: number;
  let title: string;
  let body: string;
  let nextMode: "sitting" | "standing";
  let nextReminders: number;

  if (currentMode === "sitting") {
    const alertSecs = sittingAlertMinutes * 60;
    const intervalSecs = reminderIntervalMinutes * 60;

    if (remindersFired === 0) {
      nextDelaySecs = alertSecs - params.elapsedSeconds;
      title = "Time to stand!";
      body = `You've been sitting for ${sittingAlertMinutes} minutes.`;
      nextReminders = 1;
    } else if (remindersFired <= remindersCount) {
      nextDelaySecs = intervalSecs;
      title = `Stand up — reminder ${remindersFired}/${remindersCount}`;
      body = "Time to take a standing break.";
      nextReminders = remindersFired + 1;
    } else {
      return; // all reminders exhausted
    }

    nextMode = "sitting";

  } else {
    const minSecs = standingMinMinutes * 60;
    const maxSecs = standingMaxMinutes * 60;
    const intervalSecs = reminderIntervalMinutes * 60;

    if (remindersFired === 0) {
      nextDelaySecs = minSecs - params.elapsedSeconds;
      title = "Time to sit!";
      body = `You've been standing for ${standingMinMinutes} minutes.`;
      nextReminders = 1;
      nextMode = "standing";
    } else if (remindersFired < remindersCount) {
      nextDelaySecs = intervalSecs;
      title = `Sit down — reminder ${remindersFired}/${remindersCount}`;
      body = "Time to take a seated break.";
      nextReminders = remindersFired + 1;
      nextMode = "standing";
    } else {
      nextDelaySecs =
        maxSecs - standingMinMinutes * 60 - (remindersFired - 1) * intervalSecs;
      title = "Final reminder — please sit down";
      body = `Maximum standing time of ${standingMaxMinutes} minutes reached.`;
      nextReminders = 0;
      nextMode = "sitting";
    }
  }

  if (nextDelaySecs <= 0) nextDelaySecs = 5;

  const nextTriggerAt = Date.now() + nextDelaySecs * 1000;

  // ── Record the schedule event ────────────────────────────────────────────
  const { recentCount } = recordScheduled(userId, traceId, currentMode, nextDelaySecs);

  logger.info(
    {
      event: "timer.scheduled",
      traceId,
      userId,
      mode: currentMode,
      computedDelaySeconds: nextDelaySecs,
      nextTriggerAt: new Date(nextTriggerAt).toISOString(),
      remindersFired,
    },
    "Posture timer scheduled",
  );

  if (recentCount > LOOP_THRESHOLD) {
    logger.warn(
      { event: "timer.reschedule.loop", userId, count: recentCount, windowMs: LOOP_WINDOW_MS },
      "Posture timer reschedule loop detected — too many schedules in a short window",
    );
  }

  // ── Capture closure vars before setting the timer ────────────────────────
  const capturedTraceId = traceId;
  const capturedNextTriggerAt = nextTriggerAt;
  const capturedMode = currentMode;

  const handle = setTimeout(() => {
    // Remove the entry immediately so the subsequent scheduleNext call's
    // clearActive() finds nothing and does NOT emit a spurious "cancelled" log.
    activeTimers.delete(userId);

    const fireTime = Date.now();
    const driftMs = fireTime - capturedNextTriggerAt;

    recordFired(userId, capturedTraceId, driftMs);
    logger.info(
      {
        event: "timer.fired",
        traceId: capturedTraceId,
        userId,
        actualFireTime: new Date(fireTime).toISOString(),
        scheduledTime: new Date(capturedNextTriggerAt).toISOString(),
        driftMs,
      },
      "Posture timer fired",
    );

    // ── Notification ──────────────────────────────────────────────────────
    recordNotificationAttempt(userId, capturedTraceId, capturedMode);
    logger.info(
      { event: "notification.attempt", traceId: capturedTraceId, userId, mode: capturedMode },
      "Posture notification attempt",
    );

    void sendPushToUser(userId, { title, body, type: "posture", tag: "timer-reminder" })
      .then(() => {
        recordNotificationSent(userId, capturedTraceId, true);
        logger.info(
          { event: "notification.sent", traceId: capturedTraceId, userId, success: true },
          "Posture notification sent",
        );
      })
      .catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        recordNotificationSent(userId, capturedTraceId, false, errorMessage);
        logger.error(
          { event: "notification.sent", traceId: capturedTraceId, userId, success: false, err },
          "Posture notification failed",
        );
      });

    // ── Reschedule next cycle with a fresh traceId ────────────────────────
    const nextTraceId = `${userId}-${Date.now()}`;
    scheduleNext(userId, { ...params, elapsedSeconds: 0 }, nextMode, nextReminders, nextTraceId);
  }, nextDelaySecs * 1000);

  activeTimers.set(userId, { handle, traceId, nextTriggerAt });
}

export function schedulePushNotifications(
  userId: string,
  params: ScheduleParams,
  traceId: string,
): void {
  scheduleNext(userId, params, params.mode, 0, traceId);
}

export function cancelPushSchedule(
  userId: string,
  reason: CancelReason = "manual",
): void {
  clearActive(userId, reason);
  // clearActive already logs if there was an active timer.
  // Log separately when nothing was active so callers can see the no-op.
  if (!activeTimers.has(userId)) {
    // Entry already removed by clearActive; log only when there was nothing.
  }
}

/** Returns true when a posture timer is currently in-flight for this user. */
export function hasActivePostureTimer(userId: string): boolean {
  return activeTimers.has(userId);
}

/** Returns the number of posture timers currently in-flight. */
export function getActiveTimerCount(): number {
  return activeTimers.size;
}

/** Returns the list of userIds that currently have an in-flight posture timer. */
export function getActiveTimerUserIds(): string[] {
  return Array.from(activeTimers.keys());
}

// ─── Bladder push ─────────────────────────────────────────────────────────────
// Separate per-user timer for bladder reminders. Unlike posture, bladder uses a
// single one-shot push rather than a repeating schedule.

const bladderTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleBladderPush(userId: string, delayMs: number, logId: string): void {
  const existing = bladderTimers.get(userId);
  if (existing !== undefined) clearTimeout(existing);

  const clampedDelay = Math.max(delayMs, 0);
  logger.info({ userId, delayMs: clampedDelay, logId }, "Bladder push scheduled");

  bladderTimers.set(
    userId,
    setTimeout(() => {
      bladderTimers.delete(userId);
      void sendPushToUser(userId, {
        title: "Time to void",
        body: "Go now. Do not delay.",
        tag: "bladder-reminder",
        type: "bladder",
        logId,
      }).catch((err: unknown) =>
        logger.error({ err }, "Bladder push send failed"),
      );
    }, clampedDelay),
  );
}

export function cancelBladderPush(userId: string): void {
  const t = bladderTimers.get(userId);
  if (t !== undefined) {
    clearTimeout(t);
    bladderTimers.delete(userId);
    logger.info({ userId }, "Bladder push cancelled");
  }
}
