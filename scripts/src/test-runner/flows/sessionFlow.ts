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

export const sessionFlow = {
  name: "Session Lifecycle",
  requiresAuth: true,

  async run(config: RunnerConfig, reporter: Reporter): Promise<void> {
    reporter.startFlow(sessionFlow.name);

    if (!config.authToken) {
      reporter.skip(sessionFlow.name, "TEST_AUTH_TOKEN not set");
      return;
    }

    const ctx = new TestContext();

    try {
      // ── Step 1: Start session ────────────────────────────────────────────
      reporter.step("POST /sessions (mode: sitting)");
      const startRes = await apiFetch<SessionDto>(config, "POST", "/sessions", {
        mode: "sitting",
      });
      if (!startRes.ok) {
        throw new Error(`POST /sessions failed with status ${startRes.status}: ${JSON.stringify(startRes.body)}`);
      }
      ctx.sessionId = startRes.body.id;

      // ── Step 2: Derive userId from system-state ──────────────────────────
      reporter.step("GET /debug/system-state (derive userId)");
      const stateAfterStart = await getSystemState(config);
      if (stateAfterStart.usersWithActiveSessions.length === 0) {
        throw new Error("No active sessions visible in system-state after POST /sessions");
      }
      ctx.userId = stateAfterStart.usersWithActiveSessions[0];

      // ── Step 3: Assert session + timer active ────────────────────────────
      reporter.step("Assert: single active session + timer", `userId=${ctx.userId}`);
      assertSingleActiveSession(stateAfterStart, ctx.userId);
      assertSingleTimer(stateAfterStart, ctx.userId);
      assertNoInvariantFailures(stateAfterStart);
      assertTimerSessionParity(stateAfterStart);

      // ── Step 4: End session ──────────────────────────────────────────────
      reporter.step(`PATCH /sessions/${ctx.sessionId} (end)`);
      const endRes = await apiFetch(config, "PATCH", `/sessions/${ctx.sessionId}`, {});
      if (!endRes.ok) {
        throw new Error(`PATCH /sessions/${ctx.sessionId} failed with status ${endRes.status}`);
      }

      // ── Step 5: Assert session + timer gone ──────────────────────────────
      reporter.step("GET /debug/system-state (post-end)");
      const stateAfterEnd = await getSystemState(config);
      reporter.step("Assert: no active session, no timer");
      assertNoActiveSession(stateAfterEnd, ctx.userId);
      assertNoTimer(stateAfterEnd, ctx.userId);
      assertNoInvariantFailures(stateAfterEnd);

      reporter.pass(sessionFlow.name);
    } catch (e) {
      reporter.fail(sessionFlow.name, e);
      // Cleanup: try to end session if still open
      if (ctx.sessionId) {
        await apiFetch(config, "PATCH", `/sessions/${ctx.sessionId}`, {}).catch(() => {});
      }
      throw e;
    }
  },
};
