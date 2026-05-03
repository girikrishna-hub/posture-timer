import { apiFetch, getSystemState, pollUntil } from "../apiClient.js";
import { TestContext } from "../context.js";
import { Reporter } from "../reporter.js";
import {
  assertSingleActiveSession,
  assertSingleTimer,
  assertNotificationSentSuccess,
  assertPushDelivered,
  captureAnomalyBaseline,
  assertNoNewAnomalies,
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
    // If there are no real browser subscriptions we self-register a fake-201
    // sub so web-push has somewhere to deliver to and notification.sent can
    // fire with success=true.  Tracked here for cleanup in finally.
    let fakeSub201: string | null = null;

    try {
      // ── Capture anomaly baseline ──────────────────────────────────────────
      const initialState = await getSystemState(config);
      const baseline = captureAnomalyBaseline(initialState);

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
      const userId = ctx.userId;
      assertSingleActiveSession(stateAfterStart, userId);
      assertSingleTimer(stateAfterStart, userId);
      assertNoNewAnomalies(baseline, stateAfterStart, "post-start");

      // ── Step 4b: Self-register a fake-201 sub if no real subs exist ──────
      // web-push hardcodes https.request — the endpoint must be real HTTPS.
      // The server returns fakeEndpointBase = https://$REPLIT_DEV_DOMAIN/api.
      // A 201 response from the fake endpoint makes web-push report success=true
      // so notification.sent fires even with no real browser subscription.
      const subCount = stateAfterStart.subscriptionCounts[userId] ?? 0;
      if (subCount === 0) {
        reporter.step(
          "No real push subscriptions found — registering temporary fake-201 sub for delivery test",
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
        // Pre-clean in case a stale row exists from a crashed previous run.
        await apiFetch(config, "DELETE", "/push/subscribe", { endpoint: fakeSub201 }).catch(() => {});
        const regRes = await apiFetch(config, "POST", "/push/subscribe", {
          endpoint: fakeSub201,
          keys: { p256dh, auth },
        });
        if (!regRes.ok) {
          throw new Error(`POST /push/subscribe (fake-201) failed: ${regRes.status}`);
        }
        reporter.step(`Fake-201 sub registered (→ ${fakeSub201})`);
      }

      // ── Step 5: Poll until notification.sent success:true appears ────────
      reporter.step(
        `Polling for notification.sent (timeout ${PUSH_POLL_TIMEOUT_MS / 1000}s)`,
        "Waiting for timer to fire + push to send...",
      );
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
      assertNoNewAnomalies(baseline, finalState, "post-send");

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
      // ── Cleanup: end session + restore settings + remove fake sub ────────
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
