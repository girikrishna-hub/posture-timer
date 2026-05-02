import { sendPushToUser } from "./pushService";
import { logger } from "../lib/logger";

interface ScheduleParams {
  mode: "sitting" | "standing";
  elapsedSeconds: number;
  sittingAlertMinutes: number;
  standingMinMinutes: number;
  standingMaxMinutes: number;
  reminderIntervalMinutes: number;
  remindersCount: number;
}

// Per-user timer map
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearActive(userId: string): void {
  const t = activeTimers.get(userId);
  if (t !== undefined) {
    clearTimeout(t);
    activeTimers.delete(userId);
  }
}

function scheduleNext(
  userId: string,
  params: ScheduleParams,
  currentMode: "sitting" | "standing",
  remindersFired: number,
): void {
  clearActive(userId);

  const {
    sittingAlertMinutes,
    standingMinMinutes,
    standingMaxMinutes,
    reminderIntervalMinutes,
    remindersCount,
  } = params;

  if (currentMode === "sitting") {
    const alertSecs = sittingAlertMinutes * 60;
    const intervalSecs = reminderIntervalMinutes * 60;

    let nextDelaySecs: number;
    let title: string;
    let body: string;
    let nextReminders: number;

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
      return;
    }

    if (nextDelaySecs <= 0) nextDelaySecs = 5;

    logger.info({ userId, currentMode, nextDelaySecs, title }, "Scheduling push");
    activeTimers.set(userId, setTimeout(() => {
      void sendPushToUser(userId, { title, body }).catch((err: unknown) =>
        logger.error({ err }, "Push send failed"),
      );
      scheduleNext(userId, { ...params, elapsedSeconds: 0 }, "sitting", nextReminders);
    }, nextDelaySecs * 1000));

  } else {
    const minSecs = standingMinMinutes * 60;
    const maxSecs = standingMaxMinutes * 60;
    const intervalSecs = reminderIntervalMinutes * 60;

    let nextDelaySecs: number;
    let title: string;
    let body: string;
    let nextMode: "sitting" | "standing";
    let nextReminders: number;

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

    if (nextDelaySecs <= 0) nextDelaySecs = 5;

    logger.info({ userId, currentMode, nextDelaySecs, title }, "Scheduling push");
    activeTimers.set(userId, setTimeout(() => {
      void sendPushToUser(userId, { title, body }).catch((err: unknown) =>
        logger.error({ err }, "Push send failed"),
      );
      scheduleNext(userId, { ...params, elapsedSeconds: 0 }, nextMode, nextReminders);
    }, nextDelaySecs * 1000));
  }
}

export function schedulePushNotifications(userId: string, params: ScheduleParams): void {
  scheduleNext(userId, params, params.mode, 0);
}

export function cancelPushSchedule(userId: string): void {
  clearActive(userId);
  logger.info({ userId }, "Push schedule cancelled");
}
