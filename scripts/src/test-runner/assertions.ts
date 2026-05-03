import type { SystemState, AnomalyBaseline, TimerEvent } from "./types.js";

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new AssertionError(message);
}

export function assertSingleActiveSession(state: SystemState, userId?: string): void {
  if (userId) {
    assert(
      state.usersWithActiveSessions.includes(userId),
      `Expected userId ${userId} in usersWithActiveSessions, got [${state.usersWithActiveSessions.join(", ")}]`,
    );
  } else {
    assert(
      state.activeSessions === 1,
      `Expected exactly 1 active session, got ${state.activeSessions}`,
    );
  }
}

export function assertNoActiveSession(state: SystemState, userId?: string): void {
  if (userId) {
    assert(
      !state.usersWithActiveSessions.includes(userId),
      `Expected userId ${userId} NOT in usersWithActiveSessions, but found it`,
    );
  } else {
    assert(
      state.activeSessions === 0,
      `Expected 0 active sessions, got ${state.activeSessions}`,
    );
  }
}

export function assertSingleTimer(state: SystemState, userId?: string): void {
  if (userId) {
    assert(
      state.usersWithActiveTimers.includes(userId),
      `Expected userId ${userId} in usersWithActiveTimers, got [${state.usersWithActiveTimers.join(", ")}]`,
    );
    assert(
      state.timerDetails[userId]?.activeTimer !== null &&
        state.timerDetails[userId]?.activeTimer !== undefined,
      `Expected an active timer for userId ${userId}, found none`,
    );
  } else {
    assert(
      state.activeTimers === 1,
      `Expected exactly 1 active timer, got ${state.activeTimers}`,
    );
  }
}

export function assertNoTimer(state: SystemState, userId?: string): void {
  if (userId) {
    const detail = state.timerDetails[userId];
    assert(
      !detail || detail.activeTimer === null,
      `Expected no active timer for userId ${userId}, but found one (traceId: ${detail?.activeTimer?.traceId})`,
    );
  } else {
    assert(
      state.activeTimers === 0,
      `Expected 0 active timers, got ${state.activeTimers}`,
    );
  }
}

export function assertPushDelivered(
  state: SystemState,
  userId: string,
  traceId: string,
): void {
  const detail = state.timerDetails[userId];
  assert(
    !!detail,
    `No timerDetails found for userId ${userId}`,
  );

  const sentEvent = detail.recentEvents.find(
    (e: TimerEvent) => e.event === "notification.sent" && e.traceId === traceId,
  );
  assert(
    !!sentEvent,
    `No notification.sent event found for traceId ${traceId} in recentEvents: ${JSON.stringify(detail.recentEvents)}`,
  );
  assert(
    sentEvent!.success === true,
    `notification.sent for traceId ${traceId} has success=false (error: ${sentEvent!.errorMessage ?? "unknown"})`,
  );

  const receipts = state.pushReceipts[userId];
  assert(
    !!receipts,
    `No pushReceipts found for userId ${userId}`,
  );

  const received = receipts.received.find((e) => e.traceId === traceId);
  assert(
    !!received,
    `No push-received beacon found for traceId ${traceId} (got ${receipts.received.length} total received beacons)`,
  );

  const shown = receipts.shown.find((e) => e.traceId === traceId);
  assert(
    !!shown,
    `No notification-shown beacon found for traceId ${traceId} (got ${receipts.shown.length} total shown beacons)`,
  );
}

/**
 * @deprecated Use assertNoNewAnomalies(baseline, state) for delta-based checking.
 * Retained for backward compatibility with flows that assert from a clean slate.
 */
export function assertNoInvariantFailures(state: SystemState): void {
  assert(
    state.selfHealFailures === 0,
    `Expected 0 self-heal failures, got ${state.selfHealFailures}`,
  );
}

/**
 * Capture a baseline snapshot of all anomaly counters from the current system
 * state. Call at the START of a flow so assertNoNewAnomalies can detect any
 * increase during the flow rather than requiring lifetime counts to be 0.
 */
export function captureAnomalyBaseline(state: SystemState): AnomalyBaseline {
  return {
    selfHealFailures: state.selfHealFailures,
    rescheduleLoopCount: state.rescheduleLoopCount,
    invalidUserEventCount: state.invalidUserEventCount,
  };
}

/**
 * Assert that no NEW anomaly signals appeared between `baseline` (captured at
 * flow start) and `after` (captured at flow end or a checkpoint within it).
 *
 * Checks:
 *   - selfHealFailures    — push/timer invariant mismatch that self-heal couldn't fix
 *   - rescheduleLoopCount — timer rescheduling faster than LOOP_THRESHOLD/LOOP_WINDOW
 *   - invalidUserEventCount — empty/null userId reaching the orchestrator
 */
export function assertNoNewAnomalies(
  baseline: AnomalyBaseline,
  after: SystemState,
  label = "",
): void {
  const prefix = label ? `[${label}] ` : "";

  const newSelfHeal = after.selfHealFailures - baseline.selfHealFailures;
  assert(
    newSelfHeal === 0,
    `${prefix}${newSelfHeal} new self-heal failure(s) detected (lifetime: ${after.selfHealFailures})`,
  );

  const newLoops = after.rescheduleLoopCount - baseline.rescheduleLoopCount;
  assert(
    newLoops === 0,
    `${prefix}${newLoops} new timer.reschedule.loop event(s) detected (lifetime: ${after.rescheduleLoopCount})`,
  );

  const newInvalidUser = after.invalidUserEventCount - baseline.invalidUserEventCount;
  assert(
    newInvalidUser === 0,
    `${prefix}${newInvalidUser} new orchestrator.invalid_user event(s) detected (lifetime: ${after.invalidUserEventCount})`,
  );
}

export function assertTimerSessionParity(state: SystemState): void {
  const sessionSet = new Set(state.usersWithActiveSessions);
  const timerSet = new Set(state.usersWithActiveTimers);
  for (const uid of timerSet) {
    assert(
      sessionSet.has(uid),
      `UserId ${uid} has an active timer but no active session (timer/session parity violation)`,
    );
  }
}

export function assertNotificationSentSuccess(
  state: SystemState,
  userId: string,
  traceId: string,
): void {
  const detail = state.timerDetails[userId];
  assert(!!detail, `No timerDetails for userId ${userId}`);

  const sent = detail.recentEvents.find(
    (e: TimerEvent) => e.event === "notification.sent" && e.traceId === traceId,
  );
  assert(
    !!sent,
    `No notification.sent event for traceId ${traceId}`,
  );
  assert(
    sent!.success === true,
    `push.send.result was not success for traceId ${traceId}: ${sent!.errorMessage ?? "no_subscriptions or unknown"}`,
  );
}

/**
 * Assert that no two traceIds in the given array are the same.
 * Use this in the duration flow to verify a timer never reuses a traceId
 * across cycles (which would indicate duplicate-fire or stale state bugs).
 */
export function assertUniqueTraceIds(traceIds: string[]): void {
  const seen = new Set<string>();
  for (const id of traceIds) {
    assert(
      !seen.has(id),
      `Duplicate traceId detected across cycles: ${id}. This indicates a timer fired twice or state was not properly reset between cycles.`,
    );
    seen.add(id);
  }
}

/**
 * Assert that |driftMs| is within the acceptable threshold.
 * For a 60-second timer, drift of up to 10 seconds is expected in a busy
 * process; anything beyond 30 seconds indicates a scheduling problem.
 */
export function assertBoundedDrift(
  driftMs: number,
  thresholdMs: number,
  label: string,
): void {
  assert(
    Math.abs(driftMs) <= thresholdMs,
    `Timer drift for ${label} exceeded threshold: |${driftMs}ms| > ${thresholdMs}ms`,
  );
}
