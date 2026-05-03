import { apiFetch, getSystemState } from "../apiClient.js";
import { TestContext } from "../context.js";
import { Reporter } from "../reporter.js";
import {
  assertSingleActiveSession,
  assertNoActiveSession,
  assertSingleTimer,
  assertNoTimer,
  assertNoInvariantFailures,
  assertTimerSessionParity,
} from "../assertions.js";
import type { RunnerConfig, SessionDto } from "../types.js";

export const recoveryFlow = {
  name: "Timer Recovery (Startup Reconciliation Simulation)",
  requiresAuth: true,

  async run(config: RunnerConfig, reporter: Reporter): Promise<void> {
    reporter.startFlow(recoveryFlow.name);

    if (!config.authToken) {
      reporter.skip(recoveryFlow.name, "TEST_AUTH_TOKEN not set");
      return;
    }

    const ctx = new TestContext();

    try {
      // ── Step 1: Pre-flight cleanup (end any session left by a prior flow) ─
      reporter.step("GET /sessions/active (pre-flight cleanup)");
      const activeRes = await apiFetch<{ session: SessionDto | null }>(config, "GET", "/sessions/active");
      if (activeRes.ok && activeRes.body?.session?.id) {
        reporter.step(`Ending stale session id=${activeRes.body.session.id} before recovery test`);
        await apiFetch(config, "PATCH", `/sessions/${activeRes.body.session.id}`, {}).catch(() => {});
      }

      // ── Step 2: Start a session ──────────────────────────────────────────
      reporter.step("POST /sessions (mode: standing)");
      const startRes = await apiFetch<SessionDto>(config, "POST", "/sessions", {
        mode: "standing",
      });
      if (!startRes.ok) {
        throw new Error(`POST /sessions failed: ${startRes.status} ${JSON.stringify(startRes.body)}`);
      }
      ctx.sessionId = startRes.body.id;

      // ── Step 2: Derive userId, confirm timer is running ──────────────────
      reporter.step("GET /debug/system-state (confirm timer running)");
      const stateAfterStart = await getSystemState(config);
      if (stateAfterStart.usersWithActiveSessions.length === 0) {
        throw new Error("No active sessions visible after POST /sessions");
      }
      ctx.userId = stateAfterStart.usersWithActiveSessions[0];
      assertSingleActiveSession(stateAfterStart, ctx.userId);
      assertSingleTimer(stateAfterStart, ctx.userId);
      assertNoInvariantFailures(stateAfterStart);

      const traceIdBefore = stateAfterStart.timerDetails[ctx.userId]?.activeTimer?.traceId;
      reporter.step("Timer confirmed active", `traceId=${traceIdBefore}`);

      // ── Step 3: Simulate restart reconciliation via POST /push/schedule ──
      //
      //   POST /push/schedule calls postureOrchestrator.syncTimerWithSession(userId)
      //   which is exactly the same logic as startup reconciliation.
      //   This re-derives the timer from the active DB session state,
      //   ensuring recovery works correctly even if in-memory state was lost.
      reporter.step("POST /push/schedule (simulate startup reconciliation)");
      const syncRes = await apiFetch<{ ok: boolean; scheduled: boolean }>(
        config,
        "POST",
        "/push/schedule",
        { mode: "standing" },
      );
      if (!syncRes.ok) {
        throw new Error(`POST /push/schedule failed: ${syncRes.status}`);
      }
      if (!syncRes.body.scheduled) {
        throw new Error("Expected scheduled=true after reconciliation sync, got false");
      }
      reporter.step("Sync result", `scheduled=${syncRes.body.scheduled}`);

      // ── Step 4: Verify state after resync ────────────────────────────────
      reporter.step("GET /debug/system-state (post-resync)");
      const stateAfterSync = await getSystemState(config);

      reporter.step("Assert: session intact, timer restored");
      assertSingleActiveSession(stateAfterSync, ctx.userId);
      assertSingleTimer(stateAfterSync, ctx.userId);
      assertNoInvariantFailures(stateAfterSync);
      assertTimerSessionParity(stateAfterSync);

      const traceIdAfter = stateAfterSync.timerDetails[ctx.userId]?.activeTimer?.traceId;
      reporter.step("Timer re-confirmed", `traceId=${traceIdAfter}`);

      // ── Step 5: End session — timer should cancel automatically ──────────
      reporter.step(`PATCH /sessions/${ctx.sessionId} (end session)`);
      const endRes = await apiFetch(config, "PATCH", `/sessions/${ctx.sessionId}`, {});
      if (!endRes.ok) {
        throw new Error(`PATCH /sessions/${ctx.sessionId} failed: ${endRes.status}`);
      }
      ctx.sessionId = null; // mark as handled so finally doesn't double-end

      reporter.step("GET /debug/system-state (post-end)");
      const stateAfterEnd = await getSystemState(config);
      reporter.step("Assert: no active session, no timer");
      assertNoActiveSession(stateAfterEnd, ctx.userId);
      assertNoTimer(stateAfterEnd, ctx.userId);
      assertNoInvariantFailures(stateAfterEnd);

      reporter.pass(recoveryFlow.name);
    } catch (e) {
      reporter.fail(recoveryFlow.name, e);
      throw e;
    } finally {
      if (ctx.sessionId) {
        await apiFetch(config, "PATCH", `/sessions/${ctx.sessionId}`, {}).catch(() => {});
      }
    }
  },
};
