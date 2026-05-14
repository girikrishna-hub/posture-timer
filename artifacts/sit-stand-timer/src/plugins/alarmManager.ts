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

export interface AlarmManagerPlugin {
  scheduleAlarm(options: ScheduleAlarmOptions): Promise<void>;
  cancelAlarm(options: { id: number }): Promise<void>;
  cancelAlarms(options: { ids: number[] }): Promise<void>;
  canScheduleExactAlarms(): Promise<{ value: boolean }>;
}

// Web stub — all methods silently succeed so the calling code never needs
// to check the platform before calling.
const webStub: AlarmManagerPlugin = {
  scheduleAlarm:         async () => {},
  cancelAlarm:           async () => {},
  cancelAlarms:          async () => {},
  canScheduleExactAlarms: async () => ({ value: false }),
};

export const AlarmManager = registerPlugin<AlarmManagerPlugin>(
  "AlarmManager",
  { web: webStub },
);
