export type SessionMode = "sitting" | "standing" | "resting" | "walking";

export interface SessionDto {
  id: number;
  mode: SessionMode;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  restType: string | null;
}

export interface TimerEvent {
  event:
    | "timer.scheduled"
    | "timer.cancelled"
    | "timer.fired"
    | "notification.attempt"
    | "notification.sent";
  traceId: string;
  timestamp: number;
  mode?: string;
  reason?: string;
  computedDelaySeconds?: number;
  nextTriggerAt?: number;
  driftMs?: number;
  success?: boolean;
  errorMessage?: string;
}

export interface ActiveTimerState {
  traceId: string;
  mode: string;
  scheduledAt: number;
  nextTriggerAt: number;
  computedDelaySeconds: number;
  msUntilTrigger: number;
}

export interface PushReceiptEvent {
  event: "push-received" | "notification-shown";
  clientTimestamp: number;
  serverTimestamp: number;
  traceId: string;
  payloadType: string;
}

export interface TimerDetail {
  activeTimer: ActiveTimerState | null;
  recentEvents: TimerEvent[];
}

export interface PushReceiptDetail {
  received: PushReceiptEvent[];
  shown: PushReceiptEvent[];
}

export interface SystemState {
  activeSessions: number;
  activeTimers: number;
  usersWithActiveSessions: string[];
  usersWithActiveTimers: string[];
  selfHealFailures: number;
  timerDetails: Record<string, TimerDetail>;
  pushReceipts: Record<string, PushReceiptDetail>;
}

export interface SettingsDto {
  id: number;
  sittingAlertMinutes: number;
  standingMinMinutes: number;
  standingMaxMinutes: number;
  reminderIntervalMinutes: number;
  remindersCount: number;
  dailyStandingGoalMinutes: number;
  autoDetectWalking: boolean;
}

export interface RunnerConfig {
  baseUrl: string;
  authToken: string | null;
  verbose: boolean;
}

export interface FlowResult {
  name: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  error?: string;
  skipReason?: string;
}
