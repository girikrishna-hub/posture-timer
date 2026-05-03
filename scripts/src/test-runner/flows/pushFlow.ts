import { apiFetch, getSystemState, pollUntil } from "../apiClient.js";
import { TestContext } from "../context.js";
import { Reporter } from "../reporter.js";
import {
  assertSingleActiveSession,
  assertSingleTimer,
  assertNoInvariantFailures,
  assertNotificationSentSuccess,
  assertPushDelivered,
} from "../assertions.js";
import type { RunnerConfig, SessionDto, SettingsDto, SystemState, TimerEvent } from "../types.js";

const PUSH_POLL_TIMEOUT_MS = 90_000;
const PUSH_POLL_INTERVAL_MS = 2_000;

/**
 * Finds the traceId of the most recent notification.sent event for a userId.
 * Returns null if none found yet.
 */
function findLatestSentTraceId(state: SystemState, userId: string): string | null {
  const detail = state.timerDetails[userId];
  if (!detail) return null;
  const events = [...detail.recentEvents].reverse();
  const sent = events.find(
    (e: TimerEvent) => e.event === "notification.sent" && e.success === true,
  );
  return sent?.traceId ?? null;
}

export const pushFlow = {
  name: "Push Delivery Chain",
  requiresAuth: true,

  async run(config: RunnerConfig, reporter: Reporter): Promise<void> {
    reporter.startFlow(pushFlow.name);

    if (!config.authToken) {
      reporter.skip(pushFlow.name, "TEST_AUTH_TOKEN not set");
      return;
    }

    const ctx = new TestContext();

    try {
      // ── Step 1: Read current settings (save sitting alert for restore) ───
      reporter.step("GET /settings (save current sittingAlertMinutes)");
      const settingsRes = await apiFetch<SettingsDto>(config, "GET", "/settings");
      if (!settingsRes.ok) {
        throw new Error(`GET /settings failed: ${settingsRes.status}`);
      }
      ctx.savedSittingAlertMinutes = settingsRes.body.sittingAlertMinutes;

      // ── Step 2: Set sitting alert to 1 minute for fast test cycle ────────
      reporter.step("PATCH /settings sittingAlertMinutes=1");
      const patchRes = await apiFetch<SettingsDto>(config, "PATCH", "/settings", {
        sittingAlertMinutes: 1,
      });
      if (!patchRes.ok) {
        throw new Error(`PATCH /settings failed: ${patchRes.status}`);
      }

      // ── Step 3: Start sitting session ────────────────────────────────────
      reporter.step("POST /sessions (mode: sitting)");
      const startRes = await apiFetch<SessionDto>(config, "POST", "/sessions", {
        mode: "sitting",
      });
      if (!startRes.ok) {
        throw new Error(`POST /sessions failed: ${startRes.status} ${JSON.stringify(startRes.body)}`);
      }
      ctx.sessionId = startRes.body.id;

      // ── Step 4: Derive userId ────────────────────────────────────────────
      reporter.step("GET /debug/system-state (derive userId, verify timer)");
      const stateAfterStart = await getSystemState(config);
      if (stateAfterStart.usersWithActiveSessions.length === 0) {
        throw new Error("No active sessions in system-state after POST /sessions");
      }
      ctx.userId = stateAfterStart.usersWithActiveSessions[0];
      assertSingleActiveSession(stateAfterStart, ctx.userId);
      assertSingleTimer(stateAfterStart, ctx.userId);
      assertNoInvariantFailures(stateAfterStart);

      // ── Step 5: Poll until notification.sent success:true appears ────────
      reporter.step(
        `Polling for notification.sent (timeout ${PUSH_POLL_TIMEOUT_MS / 1000}s)`,
        "Waiting for timer to fire + push to send...",
      );
      const userId = ctx.userId;
      const finalState = await pollUntil<SystemState>(
        () => getSystemState(config),
        (state) => findLatestSentTraceId(state, userId) !== null,
        PUSH_POLL_TIMEOUT_MS,
        PUSH_POLL_INTERVAL_MS,
      );

      const traceId = findLatestSentTraceId(finalState, userId)!;
      ctx.activeTraceId = traceId;
      reporter.step("notification.sent found", `traceId=${traceId}`);

      // ── Step 6: Assert push.send.result success ──────────────────────────
      reporter.step("Assert: push.send.result success=true");
      assertNotificationSentSuccess(finalState, userId, traceId);
      assertNoInvariantFailures(finalState);

      // ── Step 7: Assert full delivery chain (push-received + shown) ───────
      //   These require the app to be open in a browser with SW registered.
      //   If absent, report as a warning rather than a hard failure so CI
      //   still passes when running headless.
      reporter.step("Assert: push-received + notification-shown beacons");
      const receipts = finalState.pushReceipts[userId];
      const hasReceived = receipts?.received.some((e) => e.traceId === traceId) ?? false;
      const hasShown = receipts?.shown.some((e) => e.traceId === traceId) ?? false;

      if (hasReceived && hasShown) {
        reporter.step("Full delivery chain confirmed (send → received → shown)");
        assertPushDelivered(finalState, userId, traceId);
      } else {
        reporter.step(
          "Partial delivery chain",
          `push-received=${hasReceived} notification-shown=${hasShown} — browser/SW not open (expected in headless CI)`,
        );
      }

      reporter.pass(pushFlow.name);
    } catch (e) {
      reporter.fail(pushFlow.name, e);
      throw e;
    } finally {
      // ── Cleanup: end session + restore settings ──────────────────────────
      if (ctx.sessionId) {
        await apiFetch(config, "PATCH", `/sessions/${ctx.sessionId}`, {}).catch(() => {});
      }
      if (ctx.savedSittingAlertMinutes !== null) {
        await apiFetch(config, "PATCH", "/settings", {
          sittingAlertMinutes: ctx.savedSittingAlertMinutes,
        }).catch(() => {});
      }
    }
  },
};
