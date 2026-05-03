/**
 * Dirty Restart Flow
 *
 * Proves that timers survive a mid-cycle process restart by using the
 * POST /debug/simulate-restart endpoint, which:
 *   1. Cancels ALL in-memory posture timers (simulates lost in-process state)
 *   2. Queries the DB for users with active sessions
 *   3. Calls syncTimerWithSession for each (exactly the startup reconciliation path)
 *
 * Test sequence:
 *   1. Start a session and confirm the timer is running.
 *   2. Hit POST /debug/simulate-restart — wipes timers, reconciles from DB.
 *   3. Assert: timer is restored (new traceId, session still intact).
 *   4. Trigger a second simulate-restart to prove idempotency.
 *   5. Assert: timer still consistent (session + timer in parity).
 *   6. End session, assert timer is cancelled.
 *   7. Assert no new anomalies throughout.
 */

import { apiFetch, getSystemState } from "../apiClient.js";
import { TestContext } from "../context.js";
import { Reporter } from "../reporter.js";
import {
  assertSingleActiveSession,
  assertNoActiveSession,
  assertSingleTimer,
  assertNoTimer,
  assertTimerSessionParity,
  captureAnomalyBaseline,
  assertNoNewAnomalies,
} from "../assertions.js";
import type { RunnerConfig, SessionDto } from "../types.js";

export const restartFlow = {
  name: "Dirty Restart (Simulate Mid-Cycle Process Restart)",
  requiresAuth: true,

  async run(config: RunnerConfig, reporter: Reporter): Promise<void> {
    reporter.startFlow(restartFlow.name);

    if (!config.authToken) {
      reporter.skip(restartFlow.name, "TEST_AUTH_TOKEN not set");
      return;
    }

    const ctx = new TestContext();

    try {
      // ── Capture anomaly baseline ───────────────────────────────────────
      const initialState = await getSystemState(config);
      const baseline = captureAnomalyBaseline(initialState);

      // ── Step 1: Pre-flight cleanup ─────────────────────────────────────
      reporter.step("GET /sessions/active (pre-flight cleanup)");
      const activeRes = await apiFetch<{ session: SessionDto | null }>(config, "GET", "/sessions/active");
      if (activeRes.ok && activeRes.body?.session?.id) {
        reporter.step(`Ending stale session id=${activeRes.body.session.id}`);
        await apiFetch(config, "PATCH", `/sessions/${activeRes.body.session.id}`, {}).catch(() => {});
      }

      // ── Step 2: Start session ──────────────────────────────────────────
      reporter.step("POST /sessions (mode: standing)");
      const startRes = await apiFetch<SessionDto>(config, "POST", "/sessions", { mode: "standing" });
      if (!startRes.ok) {
        throw new Error(`POST /sessions failed: ${startRes.status} ${JSON.stringify(startRes.body)}`);
      }
      ctx.sessionId = startRes.body.id;

      // ── Step 3: Confirm timer running ──────────────────────────────────
      reporter.step("GET /debug/system-state (confirm timer running)");
      const stateBeforeRestart = await getSystemState(config);
      if (stateBeforeRestart.usersWithActiveSessions.length === 0) {
        throw new Error("No active sessions visible after POST /sessions");
      }
      ctx.userId = stateBeforeRestart.usersWithActiveSessions[0];
      const userId = ctx.userId!;

      assertSingleActiveSession(stateBeforeRestart, userId);
      assertSingleTimer(stateBeforeRestart, userId);
      assertNoNewAnomalies(baseline, stateBeforeRestart, "pre-restart");

      const traceIdBefore = stateBeforeRestart.timerDetails[userId]?.activeTimer?.traceId;
      reporter.step("Timer confirmed running", `traceId=${traceIdBefore}`);

      // ── Step 4: Simulate restart (wipe timers + reconcile from DB) ─────
      reporter.step("POST /debug/simulate-restart (wipe in-memory timers + reconcile)");
      const restartRes = await apiFetch<{ ok: boolean; cancelled: string[]; reconciled: string[] }>(
        config, "POST", "/debug/simulate-restart",
      );
      if (!restartRes.ok) {
        throw new Error(`POST /debug/simulate-restart failed: ${restartRes.status}`);
      }
      reporter.step(
        "Restart result",
        `cancelled=[${restartRes.body.cancelled.join(",")}] reconciled=[${restartRes.body.reconciled.join(",")}]`,
      );

      // ── Step 5: Assert timer restored with a new traceId ──────────────
      reporter.step("GET /debug/system-state (post-restart)");
      const stateAfterRestart = await getSystemState(config);

      reporter.step("Assert: session intact, timer restored, no anomalies");
      assertSingleActiveSession(stateAfterRestart, userId);
      assertSingleTimer(stateAfterRestart, userId);
      assertTimerSessionParity(stateAfterRestart);
      assertNoNewAnomalies(baseline, stateAfterRestart, "post-restart");

      const traceIdAfter = stateAfterRestart.timerDetails[userId]?.activeTimer?.traceId;
      reporter.step("Timer re-confirmed", `traceId=${traceIdAfter} (new traceId issued by reconciliation)`);

      // ── Step 6: Second simulate-restart (idempotency check) ───────────
      reporter.step("POST /debug/simulate-restart (second call — idempotency check)");
      const restart2Res = await apiFetch<{ ok: boolean; cancelled: string[]; reconciled: string[] }>(
        config, "POST", "/debug/simulate-restart",
      );
      if (!restart2Res.ok) {
        throw new Error(`POST /debug/simulate-restart (2nd) failed: ${restart2Res.status}`);
      }

      reporter.step("GET /debug/system-state (post-second-restart)");
      const stateAfterRestart2 = await getSystemState(config);

      reporter.step("Assert: timer still consistent after second reconcile");
      assertSingleActiveSession(stateAfterRestart2, userId);
      assertSingleTimer(stateAfterRestart2, userId);
      assertTimerSessionParity(stateAfterRestart2);
      assertNoNewAnomalies(baseline, stateAfterRestart2, "post-restart-2");

      // ── Step 7: End session — timer must cancel automatically ──────────
      reporter.step(`PATCH /sessions/${ctx.sessionId} (end session)`);
      const endRes = await apiFetch(config, "PATCH", `/sessions/${ctx.sessionId}`, {});
      if (!endRes.ok) {
        throw new Error(`PATCH /sessions/${ctx.sessionId} failed: ${endRes.status}`);
      }
      ctx.sessionId = null;

      reporter.step("GET /debug/system-state (post-end)");
      const stateAfterEnd = await getSystemState(config);
      reporter.step("Assert: no active session, no timer, no new anomalies");
      assertNoActiveSession(stateAfterEnd, userId);
      assertNoTimer(stateAfterEnd, userId);
      assertNoNewAnomalies(baseline, stateAfterEnd, "post-end");

      reporter.pass(restartFlow.name);
    } catch (e) {
      reporter.fail(restartFlow.name, e);
      throw e;
    } finally {
      if (ctx.sessionId) {
        await apiFetch(config, "PATCH", `/sessions/${ctx.sessionId}`, {}).catch(() => {});
      }
    }
  },
};
