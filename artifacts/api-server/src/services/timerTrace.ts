/**
 * Timer Trace
 *
 * Pure in-memory store for posture timer observability data.
 * Callers write events here; the debug endpoint reads them.
 * This module never throws and never logs — all logging happens at call sites.
 */

export type CancelReason = "session_change" | "resync" | "manual";

export interface TimerEvent {
  event:
    | "timer.scheduled"
    | "timer.cancelled"
    | "timer.fired"
    | "notification.attempt"
    | "notification.sent";
  traceId: string;
  timestamp: number;
  mode?: "sitting" | "standing";
  reason?: CancelReason;
  computedDelaySeconds?: number;
  nextTriggerAt?: number;
  driftMs?: number;
  success?: boolean;
  errorMessage?: string;
}

export interface ActiveTimerState {
  traceId: string;
  mode: "sitting" | "standing";
  scheduledAt: number;
  nextTriggerAt: number;
  computedDelaySeconds: number;
}

// ─── Configuration ───────────────────────────────────────────────────────────

const MAX_HISTORY_PER_USER = 5;
// Reschedule-loop detection: more than LOOP_THRESHOLD schedules within
// LOOP_WINDOW_MS for the same user is considered a loop.
const LOOP_WINDOW_MS = 2_000;
const LOOP_THRESHOLD = 3;

// ─── State ───────────────────────────────────────────────────────────────────

// Currently-active timer per user (undefined when cancelled or not yet set).
const activeState = new Map<string, ActiveTimerState>();

// Last MAX_HISTORY_PER_USER events per user, oldest-first.
const eventHistory = new Map<string, TimerEvent[]>();

// Raw schedule timestamps for loop detection, newest-first (max 5).
const recentScheduleTimes = new Map<string, number[]>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function appendEvent(userId: string, event: TimerEvent): void {
  const history = eventHistory.get(userId) ?? [];
  history.push(event);
  if (history.length > MAX_HISTORY_PER_USER) history.shift();
  eventHistory.set(userId, history);
}

// ─── Write API ───────────────────────────────────────────────────────────────

/**
 * Record a scheduling event. Returns the number of recent schedule calls
 * (within LOOP_WINDOW_MS) so the caller can log a loop warning if needed.
 */
export function recordScheduled(
  userId: string,
  traceId: string,
  mode: "sitting" | "standing",
  computedDelaySeconds: number,
): { recentCount: number } {
  const now = Date.now();
  const nextTriggerAt = now + computedDelaySeconds * 1000;

  activeState.set(userId, {
    traceId,
    mode,
    scheduledAt: now,
    nextTriggerAt,
    computedDelaySeconds,
  });

  appendEvent(userId, {
    event: "timer.scheduled",
    traceId,
    timestamp: now,
    mode,
    computedDelaySeconds,
    nextTriggerAt,
  });

  // Reschedule-loop detection
  const timestamps = recentScheduleTimes.get(userId) ?? [];
  timestamps.push(now);
  if (timestamps.length > MAX_HISTORY_PER_USER) timestamps.shift();
  recentScheduleTimes.set(userId, timestamps);

  const recentCount = timestamps.filter((t) => now - t <= LOOP_WINDOW_MS).length;
  return { recentCount };
}

export function recordCancelled(
  userId: string,
  traceId: string,
  reason: CancelReason,
): void {
  activeState.delete(userId);
  appendEvent(userId, {
    event: "timer.cancelled",
    traceId,
    timestamp: Date.now(),
    reason,
  });
}

/**
 * Record that the timer fired. The entry MUST already be removed from
 * activeTimers before this is called (the callback removes it first) to
 * prevent double-logging with the subsequent `clearActive` in `scheduleNext`.
 */
export function recordFired(
  userId: string,
  traceId: string,
  driftMs: number,
): void {
  // activeState is already cleared by the timer callback before calling here.
  appendEvent(userId, {
    event: "timer.fired",
    traceId,
    timestamp: Date.now(),
    driftMs,
  });
}

export function recordNotificationAttempt(
  userId: string,
  traceId: string,
  mode: "sitting" | "standing",
): void {
  appendEvent(userId, {
    event: "notification.attempt",
    traceId,
    timestamp: Date.now(),
    mode,
  });
}

export function recordNotificationSent(
  userId: string,
  traceId: string,
  success: boolean,
  errorMessage?: string,
): void {
  appendEvent(userId, {
    event: "notification.sent",
    traceId,
    timestamp: Date.now(),
    success,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  });
}

// ─── Read API ─────────────────────────────────────────────────────────────────

export function getActiveTimerState(userId: string): ActiveTimerState | null {
  return activeState.get(userId) ?? null;
}

export function getTimerHistory(userId: string): TimerEvent[] {
  return eventHistory.get(userId) ?? [];
}

/** Returns all userIds that currently have an active timer state entry. */
export function getTrackedUserIds(): string[] {
  const ids = new Set([...activeState.keys(), ...eventHistory.keys()]);
  return Array.from(ids);
}

export { LOOP_THRESHOLD, LOOP_WINDOW_MS };
