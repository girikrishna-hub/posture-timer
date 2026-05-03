/**
 * Duration / Repeatability Flow
 *
 * Runs N back-to-back sitting push cycles (N = 3 by default, configurable via
 * TEST_DURATION_CYCLES env var). Each cycle:
 *   1. Starts a sitting session with sittingAlertMinutes=1
 *   2. Polls until notification.sent success=true appears in system-state
 *   3. Records the traceId and driftMs
 *   4. Ends the session
 *
 * Assertions (across all cycles):
 *   - Every cycle produced a notification.sent success=true
 *   - All traceIds are unique (no double-fire or stale-state reuse)
 *   - Drift per cycle stayed within ±30 seconds (lenient for a 60s timer)
 *   - No new anomalies (reschedule loops, self-heal failures, invalid users)
 *
 * Self-sufficient subscriptions:
 *   If no real browser subscription exists the flow self-registers a
 *   fake-201 sub (https://$REPLIT_DEV_DOMAIN endpoint) so web-push has
 *   somewhere to deliver to and notification.sent fires with success=true.
 */

import { apiFetch, getSystemState, pollUntil } from "../apiClient.js";
import { TestContext } from "../context.js";
import { Reporter } from "../reporter.js";
import {
  assertSingleActiveSession,
  assertSingleTimer,
  assertNoActiveSession,
  assertNoTimer,
  assertNotificationSentSuccess,
  assertUniqueTraceIds,
  assertBoundedDrift,
  captureAnomalyBaseline,
  assertNoNewAnomalies,
} from "../assertions.js";
import type { RunnerConfig, SessionDto, SettingsDto, SystemState, TimerEvent } from "../types.js";

const POLL_TIMEOUT_MS  = 90_000;
const POLL_INTERVAL_MS = 2_000;
const DRIFT_THRESHOLD_MS = 30_000;

const DEFAULT_CYCLES = 3;

function findLatestSentTraceId(state: SystemState, userId: string): string | null {
  const detail = state.timerDetails[userId];
  if (!detail) return null;
  const events = [...detail.recentEvents].reverse();
  const sent = events.find(
    (e: TimerEvent) => e.event === "notification.sent" && e.success === true,
  );
  return sent?.traceId ?? null;
}

function findDriftMs(state: SystemState, userId: string, traceId: string): number | null {
  const events = state.timerDetails[userId]?.recentEvents ?? [];
  const fired = events.find(
    (e: TimerEvent) => e.event === "timer.fired" && e.traceId === traceId,
  );
  return fired?.driftMs ?? null;
}

export const durationFlow = {
  name: "Duration / Push Repeatability",
  requiresAuth: true,

  async run(config: RunnerConfig, reporter: Reporter): Promise<void> {
    reporter.startFlow(durationFlow.name);

    if (!config.authToken) {
      reporter.skip(durationFlow.name, "TEST_AUTH_TOKEN not set");
      return;
    }

    const cycles = process.env["TEST_DURATION_CYCLES"]
      ? parseInt(process.env["TEST_DURATION_CYCLES"], 10)
      : DEFAULT_CYCLES;

    const ctx = new TestContext();
    const collectedTraceIds: string[] = [];
    // Fake-201 sub registered when no real subscriptions exist; cleaned up in finally.
    let fakeSub201: string | null = null;

    try {
      // ── Capture anomaly baseline before any cycles ─────────────────────
      const initialState = await getSystemState(config);
      const baseline = captureAnomalyBaseline(initialState);
      ctx.userId = initialState.usersWithActiveSessions[0] ?? null;

      // ── Save + set sitting alert to 1 minute ──────────────────────────
      reporter.step("GET /settings (save sittingAlertMinutes)");
      const settingsRes = await apiFetch<SettingsDto>(config, "GET", "/settings");
      if (!settingsRes.ok) throw new Error(`GET /settings failed: ${settingsRes.status}`);
      ctx.savedSittingAlertMinutes = settingsRes.body.sittingAlertMinutes;

      reporter.step("PATCH /settings sittingAlertMinutes=1");
      const patchRes = await apiFetch<SettingsDto>(config, "PATCH", "/settings", { sittingAlertMinutes: 1 });
      if (!patchRes.ok) throw new Error(`PATCH /settings failed: ${patchRes.status}`);

      // ── Self-register fake-201 sub if no real subscriptions exist ──────
      // web-push hardcodes https.request — the endpoint must be real HTTPS.
      // A 201 response from the fake endpoint makes web-push report success,
      // so notification.sent fires even with no real browser subscription.
      // Check using initial state; if userId isn't known yet use 0.
      const initialSubCount = ctx.userId
        ? (initialState.subscriptionCounts[ctx.userId] ?? 0)
        : 0;
      // We'll re-check per-userId after the first cycle creates a session;
      // for now register if the known count is 0 or there is no active user.
      // The check happens after the first session starts below.

      // ── Run each cycle ─────────────────────────────────────────────────
      for (let cycle = 1; cycle <= cycles; cycle++) {
        reporter.step(`── Cycle ${cycle}/${cycles} ──────────────────────────────────────`);

        // 1. Start session
        reporter.step(`[${cycle}] POST /sessions (mode: sitting)`);
        const startRes = await apiFetch<SessionDto>(config, "POST", "/sessions", { mode: "sitting" });
        if (!startRes.ok) {
          throw new Error(`[cycle ${cycle}] POST /sessions failed: ${startRes.status} ${JSON.stringify(startRes.body)}`);
        }
        ctx.sessionId = startRes.body.id;

        // 2. Derive userId on first cycle
        if (!ctx.userId) {
          const st = await getSystemState(config);
          if (st.usersWithActiveSessions.length === 0) {
            throw new Error(`[cycle ${cycle}] No active sessions in system-state after POST`);
          }
          ctx.userId = st.usersWithActiveSessions[0];
        }
        const userId = ctx.userId!;

        // 3. Verify timer started
        const stateAfterStart = await getSystemState(config);
        assertSingleActiveSession(stateAfterStart, userId);
        assertSingleTimer(stateAfterStart, userId);
        assertNoNewAnomalies(baseline, stateAfterStart, `cycle ${cycle} start`);

        // 3b. On first cycle: ensure there is at least 1 subscription.
        //     If not, self-register a fake-201 sub so push can succeed.
        if (cycle === 1 && fakeSub201 === null) {
          const currentSubCount = stateAfterStart.subscriptionCounts[userId] ?? 0;
          if (currentSubCount === 0) {
            reporter.step(
              `[${cycle}] No real push subscriptions found — registering temporary fake-201 sub`,
            );
            const keysRes = await apiFetch<{
              p256dh: string;
              auth: string;
              fakeEndpointBase: string;
            }>(config, "GET", "/debug/test-subscription-keys");
            if (!keysRes.ok) {
              throw new Error(`GET /debug/test-subscription-keys failed: ${keysRes.status}`);
            }
            const { p256dh, auth, fakeEndpointBase } = keysRes.body;
            fakeSub201 = `${fakeEndpointBase}/debug/fake-push-endpoint?status=201`;
            // Pre-clean in case a stale row exists from a crashed run.
            await apiFetch(config, "DELETE", "/push/subscribe", { endpoint: fakeSub201 }).catch(() => {});
            const regRes = await apiFetch(config, "POST", "/push/subscribe", {
              endpoint: fakeSub201,
              keys: { p256dh, auth },
            });
            if (!regRes.ok) {
              throw new Error(`POST /push/subscribe (fake-201) failed: ${regRes.status}`);
            }
            reporter.step(`[${cycle}] Fake-201 sub registered (→ ${fakeSub201})`);
          }
        }

        // 4. Track which traceIds we've already seen so we can detect reuse
        const priorTraceIds = new Set(collectedTraceIds);

        // 5. Poll until a NEW notification.sent success=true appears
        reporter.step(
          `[${cycle}] Polling for notification.sent (timeout ${POLL_TIMEOUT_MS / 1000}s)`,
          `Waiting for timer to fire...`,
        );
        const finalState = await pollUntil<SystemState>(
          () => getSystemState(config),
          (state) => {
            const tid = findLatestSentTraceId(state, userId);
            return tid !== null && !priorTraceIds.has(tid);
          },
          POLL_TIMEOUT_MS,
          POLL_INTERVAL_MS,
        );

        const traceId = findLatestSentTraceId(finalState, userId)!;
        reporter.step(`[${cycle}] notification.sent found traceId=${traceId}`);

        // 6. Assert delivery
        assertNotificationSentSuccess(finalState, userId, traceId);
        assertNoNewAnomalies(baseline, finalState, `cycle ${cycle} post-send`);

        // 7. Check drift
        const driftMs = findDriftMs(finalState, userId, traceId);
        if (driftMs !== null) {
          reporter.step(`[${cycle}] timer.fired driftMs=${driftMs}`);
          assertBoundedDrift(driftMs, DRIFT_THRESHOLD_MS, `cycle ${cycle}`);
        } else {
          reporter.step(`[${cycle}] timer.fired driftMs not yet in history (within MAX_HISTORY window) — skipping drift check`);
        }

        collectedTraceIds.push(traceId);

        // 8. End session
        reporter.step(`[${cycle}] PATCH /sessions/${ctx.sessionId} (end)`);
        const endRes = await apiFetch(config, "PATCH", `/sessions/${ctx.sessionId}`, {});
        if (!endRes.ok) {
          throw new Error(`[cycle ${cycle}] PATCH /sessions/${ctx.sessionId} failed: ${endRes.status}`);
        }
        ctx.sessionId = null;

        const stateAfterEnd = await getSystemState(config);
        assertNoActiveSession(stateAfterEnd, userId);
        assertNoTimer(stateAfterEnd, userId);
      }

      // ── Cross-cycle assertions ─────────────────────────────────────────
      reporter.step(`Collected traceIds (${collectedTraceIds.length} cycles): ${collectedTraceIds.join(", ")}`);
      reporter.step("Assert: all traceIds are unique across cycles");
      assertUniqueTraceIds(collectedTraceIds);

      reporter.step("Assert: no new anomalies across all cycles");
      const finalSystemState = await getSystemState(config);
      assertNoNewAnomalies(baseline, finalSystemState, "final");

      reporter.pass(durationFlow.name);
    } catch (e) {
      reporter.fail(durationFlow.name, e);
      throw e;
    } finally {
      if (ctx.sessionId) {
        await apiFetch(config, "PATCH", `/sessions/${ctx.sessionId}`, {}).catch(() => {});
      }
      if (fakeSub201) {
        await apiFetch(config, "DELETE", "/push/subscribe", { endpoint: fakeSub201 }).catch(() => {});
      }
      if (ctx.savedSittingAlertMinutes !== null) {
        await apiFetch(config, "PATCH", "/settings", {
          sittingAlertMinutes: ctx.savedSittingAlertMinutes,
        }).catch(() => {});
      }
    }
  },
};
