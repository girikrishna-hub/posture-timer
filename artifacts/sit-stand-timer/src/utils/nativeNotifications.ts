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

// ─── Full-screen intent permission (Android 14+) ────────────────────────────

/**
 * Returns whether the app may show full-screen alarm activities over the lock
 * screen. Requires explicit user grant on Android 14+. Always true below 14.
 */
export async function canUseFullScreenIntent(): Promise<boolean> {
  if (!isNativePlatform()) return true;
  try {
    const { value } = await AlarmManager.canUseFullScreenIntent();
    return value;
  } catch {
    return true;
  }
}

/** Opens the Android 14+ Settings page to grant full-screen intent permission. */
export async function openFullScreenIntentSettings(): Promise<void> {
  if (!isNativePlatform()) return;
  try { await AlarmManager.openFullScreenIntentSettings(); } catch { /* silent */ }
}

// ─── Battery optimisation ────────────────────────────────────────────────────

/**
 * Returns whether the app is exempt from battery optimisation (Doze).
 * Non-exempt apps on Samsung may have alarm delivery throttled.
 * Always true on web / below Android 6.
 */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (!isNativePlatform()) return true;
  try {
    const { value } = await AlarmManager.isIgnoringBatteryOptimizations();
    return value;
  } catch {
    return true;
  }
}

/** Opens the system dialog to request battery-optimisation exemption. */
export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  if (!isNativePlatform()) return;
  try { await AlarmManager.requestIgnoreBatteryOptimizations(); } catch { /* silent */ }
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

// ─── Ice Therapy alarm (ID range 5000) ──────────────────────────────────────

const ICE_THERAPY_ALARM_ID = 5000;

export async function cancelNativeIceTherapyAlarm(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await AlarmManager.cancelAlarms({ ids: [ICE_THERAPY_ALARM_ID] });
  } catch { /* silent */ }
}

/**
 * Schedule the ice-therapy phase-transition alarm.
 * `nextPhase` is the phase that will START when the alarm fires.
 */
export async function scheduleNativeIceTherapyAlarm(
  delayMs: number,
  nextPhase: "cool" | "rest",
): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const title = nextPhase === "cool" ? "🧊 Apply ice pack" : "♻️ Remove ice pack";
    const body  = nextPhase === "cool"
      ? "Ice On phase — keep the pack on for 20 minutes."
      : "Rest phase — let your skin warm for 20 minutes.";
    await AlarmManager.scheduleAlarm({
      id:      ICE_THERAPY_ALARM_ID,
      title,
      body,
      delayMs,
    });
  } catch { /* silent */ }
}

// ─── Schedule sitting reminders ─────────────────────────────────────────────

interface SittingSettings {
  sittingAlertMinutes:     number;
  reminderIntervalMinutes: number;
  remindersCount:          number;
  silent?:                 boolean;
  /** Milliseconds already elapsed in the current session.
   *  Used to compute remaining delay so alarms fire at the correct absolute
   *  time even when rescheduled mid-session (e.g. app reopen / hydration). */
  elapsedMs?:              number;
}

export async function scheduleNativeSittingReminders(
  s: SittingSettings,
): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const elapsed = s.elapsedMs ?? 0;
    const alertAbsMs = s.sittingAlertMinutes * 60_000;

    // First alert — skip if the threshold has already passed
    const firstDelay = alertAbsMs - elapsed;
    if (firstDelay > 0) {
      await AlarmManager.scheduleAlarm({
        id:      SITTING_BASE,
        title:   "Time to stand!",
        body:    `You've been sitting for ${s.sittingAlertMinutes} minutes. Stand up!`,
        delayMs: firstDelay,
        silent:  s.silent,
      });
    }

    // Follow-up reminders — skip any whose absolute threshold has already passed
    for (let i = 1; i <= Math.min(s.remindersCount, MAX_REMINDERS - 1); i++) {
      const absDelay    = alertAbsMs + i * s.reminderIntervalMinutes * 60_000;
      const remainingMs = absDelay - elapsed;
      if (remainingMs <= 0) continue;
      await AlarmManager.scheduleAlarm({
        id:      SITTING_BASE + i,
        title:   `Stand up — reminder ${i}/${s.remindersCount}`,
        body:    `Still sitting after ${s.sittingAlertMinutes + i * s.reminderIntervalMinutes} minutes.`,
        delayMs: remainingMs,
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
  /** Milliseconds already elapsed in the current session. See SittingSettings. */
  elapsedMs?:              number;
}

export async function scheduleNativeStandingReminders(
  s: StandingSettings,
): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const elapsed = s.elapsedMs ?? 0;
    const minAbsMs = s.standingMinMinutes * 60_000;
    const maxAbsMs = s.standingMaxMinutes * 60_000;

    // First alert at standingMinMinutes — skip if already passed
    const firstDelay = minAbsMs - elapsed;
    if (firstDelay > 0) {
      await AlarmManager.scheduleAlarm({
        id:      STANDING_BASE,
        title:   "Time to sit!",
        body:    `You've been standing for ${s.standingMinMinutes} minutes. Have a seat.`,
        delayMs: firstDelay,
        silent:  s.silent,
      });
    }

    // Intermediate reminders
    for (let i = 1; i < Math.min(s.remindersCount, MAX_REMINDERS - 1); i++) {
      const absDelay    = minAbsMs + i * s.reminderIntervalMinutes * 60_000;
      if (absDelay >= maxAbsMs) break;
      const remainingMs = absDelay - elapsed;
      if (remainingMs <= 0) continue;
      await AlarmManager.scheduleAlarm({
        id:      STANDING_BASE + i,
        title:   `Sit down — reminder ${i}/${s.remindersCount}`,
        body:    `Still standing after ${s.standingMinMinutes + i * s.reminderIntervalMinutes} minutes.`,
        delayMs: remainingMs,
        silent:  s.silent,
      });
    }

    // Hard final alert at standingMaxMinutes — skip if already passed
    const finalDelay = maxAbsMs - elapsed;
    if (finalDelay > 0) {
      await AlarmManager.scheduleAlarm({
        id:      STANDING_BASE + MAX_REMINDERS - 1,
        title:   "Final reminder — please sit down",
        body:    `Maximum standing time of ${s.standingMaxMinutes} minutes reached.`,
        delayMs: finalDelay,
        silent:  s.silent,
      });
    }
  } catch { /* silent */ }
}
