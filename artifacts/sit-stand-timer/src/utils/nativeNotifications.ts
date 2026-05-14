import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

const POSTURE_CHANNEL_ID = "posture-reminders";

// Notification IDs: 1000–1010 reserved for posture reminders
const BASE_ID = 1000;

export async function setupNativeNotificationChannel(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await LocalNotifications.createChannel({
      id: POSTURE_CHANNEL_ID,
      name: "Posture Reminders",
      description: "Sit/Stand posture alerts",
      importance: 5,       // IMPORTANCE_HIGH — heads-up banner + lock screen
      visibility: 1,       // VISIBILITY_PUBLIC — show on lock screen
      vibration: true,
      sound: "default",
      lights: true,
      lightColor: "#7ea58c",
    });
  } catch {
    // silent
  }
}

export async function requestNativeNotificationPermission(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  try {
    const { display } = await LocalNotifications.requestPermissions();
    return display === "granted";
  } catch {
    return false;
  }
}

export async function cancelAllNativePostureNotifications(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const ids = Array.from({ length: 12 }, (_, i) => ({ id: BASE_ID + i }));
    await LocalNotifications.cancel({ notifications: ids });
  } catch {
    // silent
  }
}

interface SittingSettings {
  sittingAlertMinutes: number;
  reminderIntervalMinutes: number;
  remindersCount: number;
}

export async function scheduleNativeSittingReminders(
  s: SittingSettings,
): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const alertMs = s.sittingAlertMinutes * 60 * 1000;

    const notifications = [
      {
        id: BASE_ID,
        title: "Time to stand!",
        body: `You've been sitting for ${s.sittingAlertMinutes} minutes. Stand up!`,
        channelId: POSTURE_CHANNEL_ID,
        schedule: { at: new Date(Date.now() + alertMs) },
        sound: "default",
        smallIcon: "ic_stat_notification",
        actionTypeId: "",
        extra: null,
      },
    ];

    for (let i = 1; i <= s.remindersCount; i++) {
      const delayMs = alertMs + i * s.reminderIntervalMinutes * 60 * 1000;
      notifications.push({
        id: BASE_ID + i,
        title: `Stand up — reminder ${i}/${s.remindersCount}`,
        body: `Still sitting after ${s.sittingAlertMinutes + i * s.reminderIntervalMinutes} minutes.`,
        channelId: POSTURE_CHANNEL_ID,
        schedule: { at: new Date(Date.now() + delayMs) },
        sound: "default",
        smallIcon: "ic_stat_notification",
        actionTypeId: "",
        extra: null,
      });
    }

    await LocalNotifications.schedule({ notifications });
  } catch {
    // silent
  }
}

interface StandingSettings {
  standingMinMinutes: number;
  standingMaxMinutes: number;
  reminderIntervalMinutes: number;
  remindersCount: number;
}

export async function scheduleNativeStandingReminders(
  s: StandingSettings,
): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const minMs = s.standingMinMinutes * 60 * 1000;
    const maxMs = s.standingMaxMinutes * 60 * 1000;

    const notifications = [
      {
        id: BASE_ID,
        title: "Time to sit!",
        body: `You've been standing for ${s.standingMinMinutes} minutes. Have a seat.`,
        channelId: POSTURE_CHANNEL_ID,
        schedule: { at: new Date(Date.now() + minMs) },
        sound: "default",
        smallIcon: "ic_stat_notification",
        actionTypeId: "",
        extra: null,
      },
    ];

    for (let i = 1; i < s.remindersCount; i++) {
      const delayMs = minMs + i * s.reminderIntervalMinutes * 60 * 1000;
      if (delayMs >= maxMs) break;
      notifications.push({
        id: BASE_ID + i,
        title: `Sit down — reminder ${i}/${s.remindersCount}`,
        body: `Still standing after ${s.standingMinMinutes + i * s.reminderIntervalMinutes} minutes.`,
        channelId: POSTURE_CHANNEL_ID,
        schedule: { at: new Date(Date.now() + delayMs) },
        sound: "default",
        smallIcon: "ic_stat_notification",
        actionTypeId: "",
        extra: null,
      });
    }

    // Final hard-stop at maxMinutes
    notifications.push({
      id: BASE_ID + s.remindersCount,
      title: "Final reminder — please sit down",
      body: `Maximum standing time of ${s.standingMaxMinutes} minutes reached.`,
      channelId: POSTURE_CHANNEL_ID,
      schedule: { at: new Date(Date.now() + maxMs) },
      sound: "default",
      smallIcon: "ic_stat_notification",
      actionTypeId: "",
      extra: null,
    });

    await LocalNotifications.schedule({ notifications });
  } catch {
    // silent
  }
}
