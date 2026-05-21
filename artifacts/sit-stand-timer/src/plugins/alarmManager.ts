/**
 * JavaScript bridge to the native AlarmManagerPlugin (Android only).
 *
 * On Android it uses AlarmManager.setExactAndAllowWhileIdle() so alarms fire
 * even in Doze mode, with a FullScreenIntent that wakes the screen and shows
 * AlarmFullScreenActivity above the lock screen.
 *
 * On web / iOS the plugin is a no-op stub so the rest of the code can call
 * it unconditionally without Platform checks everywhere.
 */

import { registerPlugin } from "@capacitor/core";

export interface ScheduleAlarmOptions {
  id: number;
  title: string;
  body: string;
  /** Milliseconds from now until the alarm fires. */
  delayMs: number;
}

/**
 * TEMP DIAG: snapshot of the persisted scheduling/firing state, used to
 * render an in-app debug panel while we investigate why notifications
 * are not actually firing on device. All timestamps are unix-ms; 0 means
 * "no event recorded yet". Strings may be empty.
 */
export interface AlarmDiagnostics {
  lastScheduledId: number;
  lastScheduledTitle: string;
  lastScheduledTriggerAt: number;
  lastScheduledAt: number;
  lastScheduledUsedExact: boolean;
  lastScheduledError: string;
  scheduleCount: number;
  lastCancelId: number;
  lastCancelAt: number;
  cancelCount: number;
  lastReceiverFireId: number;
  lastReceiverFireAt: number;
  lastReceiverFireTitle: string;
  lastNotifyError: string;
  receiverFireCount: number;
  notifyCount: number;
  notifyFailCount: number;
  nextAlarmClockTriggerAt: number;
  canScheduleExactAlarms: boolean;
  now: number;
}

export interface ScheduleAlarmResult {
  id: number;
  triggerAt: number;
  usedExact: boolean;
  canExact: boolean;
  error: string;
}

export interface AlarmManagerPlugin {
  scheduleAlarm(options: ScheduleAlarmOptions): Promise<ScheduleAlarmResult | void>;
  cancelAlarm(options: { id: number }): Promise<void>;
  cancelAlarms(options: { ids: number[] }): Promise<void>;
  canScheduleExactAlarms(): Promise<{ value: boolean }>;
  /** Open the system Settings page where the user grants Alarms & Reminders permission. No-op below Android 12. */
  openExactAlarmSettings(): Promise<void>;
  /** TEMP DIAG — snapshot of native scheduling/firing state for in-app debug panel. */
  getDiagnostics(): Promise<AlarmDiagnostics>;
}

const emptyDiag: AlarmDiagnostics = {
  lastScheduledId: -1,
  lastScheduledTitle: "",
  lastScheduledTriggerAt: 0,
  lastScheduledAt: 0,
  lastScheduledUsedExact: false,
  lastScheduledError: "",
  scheduleCount: 0,
  lastCancelId: -1,
  lastCancelAt: 0,
  cancelCount: 0,
  lastReceiverFireId: -1,
  lastReceiverFireAt: 0,
  lastReceiverFireTitle: "",
  lastNotifyError: "",
  receiverFireCount: 0,
  notifyCount: 0,
  notifyFailCount: 0,
  nextAlarmClockTriggerAt: 0,
  canScheduleExactAlarms: false,
  now: 0,
};

// Web stub — all methods silently succeed so the calling code never needs
// to check the platform before calling.
const webStub: AlarmManagerPlugin = {
  scheduleAlarm:          async () => {},
  cancelAlarm:            async () => {},
  cancelAlarms:           async () => {},
  canScheduleExactAlarms: async () => ({ value: false }),
  openExactAlarmSettings: async () => {},
  getDiagnostics:         async () => ({ ...emptyDiag, now: Date.now() }),
};

export const AlarmManager = registerPlugin<AlarmManagerPlugin>(
  "AlarmManager",
  { web: webStub },
);
