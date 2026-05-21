/**
 * Native notification helpers.
 *
 * When running inside a Capacitor Android build the AlarmManager plugin is
 * used so that alarms fire via AlarmManager.setExactAndAllowWhileIdle() and
 * are displayed by AlarmFullScreenActivity (full-screen, above the lock
 * screen).
 *
 * When running in a browser the functions are all no-ops so the calling code
 * (TimerContext) never needs to check the platform itself.
 */

import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { AlarmManager } from "@/plugins/alarmManager";

// ─── Platform detection ─────────────────────────────────────────────────────

export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

// ─── Notification channel (LocalNotifications fallback) ─────────────────────
// Still created so that web-push / LocalNotification fallback paths have a
// channel to post to.  The alarm-clock path uses AlarmReceiver's own channel.

const LC_CHANNEL_ID = "posture-reminders";

export async function setupNativeNotificationChannel(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await LocalNotifications.createChannel({
      id:          LC_CHANNEL_ID,
      name:        "Posture Reminders",
      description: "Sit/Stand posture alerts",
      importance:  5,   // IMPORTANCE_HIGH
      visibility:  1,   // VISIBILITY_PUBLIC
      vibration:   true,
      sound:       "default",
      lights:      true,
      lightColor:  "#7ea58c",
    });
  } catch { /* silent */ }
}

// ─── Permission ─────────────────────────────────────────────────────────────

export async function requestNativeNotificationPermission(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  try {
    const { display } = await LocalNotifications.requestPermissions();
    return display === "granted";
  } catch {
    return false;
  }
}

// ─── Alarm IDs ──────────────────────────────────────────────────────────────
//
//  2000 … 2010  →  sitting reminders
//  3000 … 3010  →  standing reminders
//
// Using separate ranges means cancelling sitting alarms never touches
// standing alarms and vice-versa.

const SITTING_BASE  = 2000;
const STANDING_BASE = 3000;
const BLADDER_BASE  = 4000;
const MAX_REMINDERS = 11;

// ─── Cancel helpers ─────────────────────────────────────────────────────────

export async function cancelSittingAlarms(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const ids = Array.from({ length: MAX_REMINDERS }, (_, i) => SITTING_BASE + i);
    await AlarmManager.cancelAlarms({ ids });
  } catch { /* silent */ }
}

export async function cancelStandingAlarms(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const ids = Array.from({ length: MAX_REMINDERS }, (_, i) => STANDING_BASE + i);
    await AlarmManager.cancelAlarms({ ids });
  } catch { /* silent */ }
}

export async function cancelAllNativePostureNotifications(): Promise<void> {
  await cancelSittingAlarms();
  await cancelStandingAlarms();
}

// ─── Exact-alarm permission ──────────────────────────────────────────────────
// On Android 12+ the user must explicitly grant SCHEDULE_EXACT_ALARM in
// Settings → Apps → Special access → Alarms & reminders.  Without it the
// AlarmManager plugin falls back to inexact delivery (~10 min drift).

/** Returns true if exact alarms can be scheduled (always true on web). */
export async function canScheduleExactAlarms(): Promise<boolean> {
  if (!isNativePlatform()) return true;
  try {
    const { value } = await AlarmManager.canScheduleExactAlarms();
    return value;
  } catch {
    return false;
  }
}

/**
 * Opens the OS settings page so the user can grant the exact-alarm permission.
 * Returns whether the permission was already granted before opening.
 */
export async function openExactAlarmSettings(): Promise<boolean> {
  if (!isNativePlatform()) return true;
  try {
    const { value } = await AlarmManager.canScheduleExactAlarms();
    if (!value) await AlarmManager.openExactAlarmSettings();
    return value;
  } catch {
    return false;
  }
}

// ─── Cancel bladder alarm ────────────────────────────────────────────────────

export async function cancelNativeBladderAlarm(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    // Cancel both the main alarm and the snooze slot
    await AlarmManager.cancelAlarms({ ids: [BLADDER_BASE, BLADDER_BASE + 500] });
  } catch { /* silent */ }
}

// ─── Schedule bladder alarm ──────────────────────────────────────────────────

export async function scheduleNativeBladderAlarm(
  delayMs: number,
  intervalMinutes: number,
): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await AlarmManager.scheduleAlarm({
      id:      BLADDER_BASE,
      title:   "Time to void",
      body:    `Your ${intervalMinutes}-minute bladder timer has fired. Go now — do not delay.`,
      delayMs,
    });
  } catch { /* silent */ }
}

// ─── Schedule sitting reminders ─────────────────────────────────────────────

interface SittingSettings {
  sittingAlertMinutes:    number;
  reminderIntervalMinutes: number;
  remindersCount:          number;
  silent?:                 boolean;
}

export async function scheduleNativeSittingReminders(
  s: SittingSettings,
): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const alertMs = s.sittingAlertMinutes * 60_000;

    // First alert
    await AlarmManager.scheduleAlarm({
      id:      SITTING_BASE,
      title:   "Time to stand!",
      body:    `You've been sitting for ${s.sittingAlertMinutes} minutes. Stand up!`,
      delayMs: alertMs,
      silent:  s.silent,
    });

    // Follow-up reminders
    for (let i = 1; i <= Math.min(s.remindersCount, MAX_REMINDERS - 1); i++) {
      const delayMs = alertMs + i * s.reminderIntervalMinutes * 60_000;
      await AlarmManager.scheduleAlarm({
        id:      SITTING_BASE + i,
        title:   `Stand up — reminder ${i}/${s.remindersCount}`,
        body:    `Still sitting after ${s.sittingAlertMinutes + i * s.reminderIntervalMinutes} minutes.`,
        delayMs,
        silent:  s.silent,
      });
    }
  } catch { /* silent */ }
}

// ─── Schedule standing reminders ────────────────────────────────────────────

interface StandingSettings {
  standingMinMinutes:      number;
  standingMaxMinutes:      number;
  reminderIntervalMinutes: number;
  remindersCount:          number;
  silent?:                 boolean;
}

export async function scheduleNativeStandingReminders(
  s: StandingSettings,
): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const minMs = s.standingMinMinutes  * 60_000;
    const maxMs = s.standingMaxMinutes  * 60_000;

    // First alert at standingMinMinutes
    await AlarmManager.scheduleAlarm({
      id:      STANDING_BASE,
      title:   "Time to sit!",
      body:    `You've been standing for ${s.standingMinMinutes} minutes. Have a seat.`,
      delayMs: minMs,
      silent:  s.silent,
    });

    // Intermediate reminders
    for (let i = 1; i < Math.min(s.remindersCount, MAX_REMINDERS - 1); i++) {
      const delayMs = minMs + i * s.reminderIntervalMinutes * 60_000;
      if (delayMs >= maxMs) break;
      await AlarmManager.scheduleAlarm({
        id:      STANDING_BASE + i,
        title:   `Sit down — reminder ${i}/${s.remindersCount}`,
        body:    `Still standing after ${s.standingMinMinutes + i * s.reminderIntervalMinutes} minutes.`,
        delayMs,
        silent:  s.silent,
      });
    }

    // Hard final alert at standingMaxMinutes
    await AlarmManager.scheduleAlarm({
      id:      STANDING_BASE + MAX_REMINDERS - 1,
      title:   "Final reminder — please sit down",
      body:    `Maximum standing time of ${s.standingMaxMinutes} minutes reached.`,
      delayMs: maxMs,
      silent:  s.silent,
    });
  } catch { /* silent */ }
}
