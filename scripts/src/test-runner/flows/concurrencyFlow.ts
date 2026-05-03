import { apiFetch, getSystemState } from "../apiClient.js";
import { Reporter } from "../reporter.js";
import {
  assertTimerSessionParity,
  AssertionError,
  captureAnomalyBaseline,
  assertNoNewAnomalies,
} from "../assertions.js";
import type { RunnerConfig, SessionDto } from "../types.js";

export const concurrencyFlow = {
  name: "Concurrent Session Starts",
  requiresAuth: true,

  async run(config: RunnerConfig, reporter: Reporter): Promise<void> {
    reporter.startFlow(concurrencyFlow.name);

    if (!config.authToken) {
      reporter.skip(concurrencyFlow.name, "TEST_AUTH_TOKEN not set");
      return;
    }

    const PARALLEL = 3;

    try {
      // ── Capture anomaly baseline ──────────────────────────────────────────
      const initialState = await getSystemState(config);
      const baseline = captureAnomalyBaseline(initialState);

      // ── Step 1: Ensure clean state (end any lingering session) ───────────
      reporter.step("GET /sessions/active (pre-flight cleanup)");
      const activeRes = await apiFetch<{ session: SessionDto | null }>(config, "GET", "/sessions/active");
      if (activeRes.ok && activeRes.body?.session?.id) {
        const stale = activeRes.body.session.id;
        reporter.step(`Ending stale session id=${stale} before concurrency test`);
        await apiFetch(config, "PATCH", `/sessions/${stale}`, {}).catch(() => {});
      }

      // ── Step 2: Fire N parallel POST /sessions ───────────────────────────
      reporter.step(`POST /sessions × ${PARALLEL} in parallel (same user, mode: sitting)`);
      const results = await Promise.allSettled(
        Array.from({ length: PARALLEL }, () =>
          apiFetch<SessionDto>(config, "POST", `/sessions`, { mode: "sitting" }),
        ),
      );

      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;
      reporter.step(
        `Parallel results: ${succeeded} succeeded, ${failed} rejected`,
        "(orchestrator serialises via per-user lock)",
      );

      // ── Step 3: Verify system state ──────────────────────────────────────
      reporter.step("GET /debug/system-state");
      const state = await getSystemState(config);

      reporter.step("Assert: exactly 1 active session + timer, no new anomalies");
      assertTimerSessionParity(state);
      assertNoNewAnomalies(baseline, state, "post-parallel");

      if (state.activeSessions !== 1) {
        throw new AssertionError(
          `Expected exactly 1 active session after ${PARALLEL} concurrent starts, got ${state.activeSessions}. ` +
            `Per-user locking or orphan-close logic may have failed.`,
        );
      }
      if (state.activeTimers !== 1) {
        throw new AssertionError(
          `Expected exactly 1 active timer after ${PARALLEL} concurrent starts, got ${state.activeTimers}.`,
        );
      }

      reporter.pass(concurrencyFlow.name);
    } catch (e) {
      reporter.fail(concurrencyFlow.name, e);
      throw e;
    } finally {
      // Cleanup: end ONLY the currently active session.
      //
      // Do NOT iterate over all sessionIds here — sessions 1 and 2 of the 3
      // parallel requests were already auto-closed by the orchestrator when
      // session 3 was created. Re-ending them via PATCH would update their
      // endedAt to NOW(), extending their ranges and creating overlaps with
      // session 3, which poisons assertSessionInvariants for subsequent flows.
      const activeRes = await apiFetch<{ session: SessionDto | null }>(
        config, "GET", "/sessions/active",
      ).catch(() => null);
      const activeId = activeRes?.ok ? activeRes.body?.session?.id : undefined;
      if (typeof activeId === "number") {
        await apiFetch(config, "PATCH", `/sessions/${activeId}`, {}).catch(() => {});
      }
    }
  },
};
