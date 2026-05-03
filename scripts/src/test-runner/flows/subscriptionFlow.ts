/**
 * Subscription Lifecycle Flow
 *
 * Verifies the expired-subscription cleanup path end-to-end without requiring
 * a real browser subscription. Two fake subscriptions are injected:
 *
 *   - fake-201: endpoint returns 201 → web-push treats it as success → stays alive
 *   - fake-410: endpoint returns 410 → pushService.ts auto-deletes it from DB
 *
 * Assertions:
 *   1. notification.sent success=true fires (fake-201 delivered OK)
 *   2. fake-410 row is gone from DB (count back to baseline+1 — fake-201 stays)
 *   3. No new anomalies
 *
 * Why the endpoint must be HTTPS:
 *   web-push hardcodes https.request regardless of the URL scheme in the
 *   endpoint string.  http:// and mTLS-proxied localhost:80 both fail with
 *   EPROTO.  The server returns fakeEndpointBase = https://$REPLIT_DEV_DOMAIN/api
 *   which is a real HTTPS URL the Replit proxy forwards to Express.
 */

import { apiFetch, getSystemState, pollUntil } from "../apiClient.js";
import { TestContext } from "../context.js";
import { Reporter } from "../reporter.js";
import {
  assertNotificationSentSuccess,
  captureAnomalyBaseline,
  assertNoNewAnomalies,
} from "../assertions.js";
import type { RunnerConfig, SessionDto, SettingsDto, SystemState, TimerEvent } from "../types.js";

const POLL_TIMEOUT_MS  = 90_000;
const POLL_INTERVAL_MS = 2_000;

function findLatestSentTraceId(state: SystemState, userId: string): string | null {
  const detail = state.timerDetails[userId];
  if (!detail) return null;
  const events = [...detail.recentEvents].reverse();
  const sent = events.find(
    (e: TimerEvent) => e.event === "notification.sent" && e.success === true,
  );
  return sent?.traceId ?? null;
}

export const subscriptionFlow = {
  name: "Subscription Lifecycle (Expired + Valid Mix)",
  requiresAuth: true,

  async run(config: RunnerConfig, reporter: Reporter): Promise<void> {
    reporter.startFlow(subscriptionFlow.name);

    if (!config.authToken) {
      reporter.skip(subscriptionFlow.name, "TEST_AUTH_TOKEN not set");
      return;
    }

    const ctx = new TestContext();
    // Two fake endpoints — track both so finally can clean up if the test fails
    // mid-way. The 410 endpoint should be auto-deleted by pushService on success;
    // if it was, fakeEndpoint410 is set to null. The 201 endpoint always needs
    // manual cleanup.
    let fakeEndpoint410: string | null = null;
    let fakeEndpoint201: string | null = null;

    try {
      // ── Capture anomaly baseline ───────────────────────────────────────
      const initialState = await getSystemState(config);
      const baseline = captureAnomalyBaseline(initialState);

      // ── Save + set sitting alert to 1 minute ──────────────────────────
      reporter.step("GET /settings (save sittingAlertMinutes)");
      const settingsRes = await apiFetch<SettingsDto>(config, "GET", "/settings");
      if (!settingsRes.ok) throw new Error(`GET /settings failed: ${settingsRes.status}`);
      ctx.savedSittingAlertMinutes = settingsRes.body.sittingAlertMinutes;

      reporter.step("PATCH /settings sittingAlertMinutes=1");
      const patchRes = await apiFetch<SettingsDto>(config, "PATCH", "/settings", { sittingAlertMinutes: 1 });
      if (!patchRes.ok) throw new Error(`PATCH /settings failed: ${patchRes.status}`);

      // ── Step 1: Start session to determine userId ──────────────────────
      reporter.step("POST /sessions (mode: sitting, to derive userId)");
      const startRes = await apiFetch<SessionDto>(config, "POST", "/sessions", { mode: "sitting" });
      if (!startRes.ok) {
        throw new Error(`POST /sessions failed: ${startRes.status} ${JSON.stringify(startRes.body)}`);
      }
      ctx.sessionId = startRes.body.id;

      const stateAfterStart = await getSystemState(config);
      if (stateAfterStart.usersWithActiveSessions.length === 0) {
        throw new Error("No active sessions in system-state after POST /sessions");
      }
      ctx.userId = stateAfterStart.usersWithActiveSessions[0];
      const userId = ctx.userId!;

      // ── Step 2: Fetch ECDH key pair + HTTPS base URL from server ───────
      // web-push validates the p256dh key length before sending; fake keys
      // abort the request before the HTTP response is ever examined.
      // fakeEndpointBase is https://$REPLIT_DEV_DOMAIN/api so web-push can
      // use real HTTPS (it hardcodes https.request regardless of URL scheme).
      reporter.step("GET /debug/test-subscription-keys (ECDH key pair + HTTPS base for fake subs)");
      const keysRes = await apiFetch<{
        p256dh: string;
        auth: string;
        p256dhDecodedLen: number;
        authDecodedLen: number;
        fakeEndpointBase: string;
      }>(config, "GET", "/debug/test-subscription-keys");
      if (!keysRes.ok) {
        throw new Error(`GET /debug/test-subscription-keys failed: ${keysRes.status}`);
      }
      const { p256dh, auth, p256dhDecodedLen, authDecodedLen, fakeEndpointBase } = keysRes.body;
      reporter.step(
        `Got p256dh (${p256dh.length} chars, ${p256dhDecodedLen} decoded bytes), ` +
        `auth (${auth.length} chars, ${authDecodedLen} decoded bytes)`,
      );
      if (p256dhDecodedLen !== 65) {
        throw new Error(
          `Server returned p256dh that decodes to ${p256dhDecodedLen} bytes, ` +
          `but web-push requires exactly 65 bytes. Key generation is broken.`,
        );
      }

      fakeEndpoint410 = `${fakeEndpointBase}/debug/fake-push-endpoint?status=410`;
      fakeEndpoint201 = `${fakeEndpointBase}/debug/fake-push-endpoint?status=201`;

      // ── Step 3: Pre-clean both fake endpoints, then read baseline ──────
      // A previous SIGKILL'd run may have left stale rows.  Pre-clean before
      // reading baseline so the count reflects only real subscriptions.
      reporter.step("Pre-cleaning stale fake subscription rows (if any)");
      await Promise.all([
        apiFetch(config, "DELETE", "/push/subscribe", { endpoint: fakeEndpoint410 }).catch(() => {}),
        apiFetch(config, "DELETE", "/push/subscribe", { endpoint: fakeEndpoint201 }).catch(() => {}),
      ]);

      reporter.step("GET /debug/system-state (read baseline subscription count)");
      const stateForBaseline = await getSystemState(config);
      const baselineSubs = stateForBaseline.subscriptionCounts[userId] ?? 0;
      reporter.step(
        `Baseline subscription count for userId=${userId}: ${baselineSubs}`,
        "(stale fake rows pre-cleaned; baseline = real subscriptions only)",
      );

      // ── Step 4: Inject both fake subscriptions ─────────────────────────
      // fake-201 simulates a valid live subscription (succeeds → stays in DB).
      // fake-410 simulates an expired subscription (triggers auto-delete).
      reporter.step(`Injecting fake-410 subscription (→ ${fakeEndpoint410})`);
      const sub410Res = await apiFetch(config, "POST", "/push/subscribe", {
        endpoint: fakeEndpoint410,
        keys: { p256dh, auth },
      });
      if (!sub410Res.ok) {
        throw new Error(`POST /push/subscribe (fake-410) failed: ${sub410Res.status} ${JSON.stringify(sub410Res.body)}`);
      }

      reporter.step(`Injecting fake-201 subscription (→ ${fakeEndpoint201})`);
      const sub201Res = await apiFetch(config, "POST", "/push/subscribe", {
        endpoint: fakeEndpoint201,
        keys: { p256dh, auth },
      });
      if (!sub201Res.ok) {
        throw new Error(`POST /push/subscribe (fake-201) failed: ${sub201Res.status} ${JSON.stringify(sub201Res.body)}`);
      }

      // Verify count increased by 2
      const stateAfterInject = await getSystemState(config);
      const subsAfterInject = stateAfterInject.subscriptionCounts[userId] ?? 0;
      if (subsAfterInject !== baselineSubs + 2) {
        throw new Error(
          `Expected ${baselineSubs + 2} subscriptions after injecting 2 fake ones, got ${subsAfterInject}`,
        );
      }
      reporter.step(
        `Subscription count after inject: ${subsAfterInject} (expected ${baselineSubs + 2}) ✓`,
      );

      // ── Step 5: End the preliminary session; start the real test session ─
      reporter.step(`PATCH /sessions/${ctx.sessionId} (end preliminary session)`);
      await apiFetch(config, "PATCH", `/sessions/${ctx.sessionId}`, {}).catch(() => {});
      ctx.sessionId = null;

      reporter.step("POST /sessions (mode: sitting, real test session)");
      const realStart = await apiFetch<SessionDto>(config, "POST", "/sessions", { mode: "sitting" });
      if (!realStart.ok) {
        throw new Error(`POST /sessions (real) failed: ${realStart.status} ${JSON.stringify(realStart.body)}`);
      }
      ctx.sessionId = realStart.body.id;

      // ── Step 6: Poll for notification.sent success=true ────────────────
      // The fake-201 sub makes web-push report success=true so notification.sent
      // fires even when no real browser subscription exists.
      reporter.step(
        `Polling for notification.sent (timeout ${POLL_TIMEOUT_MS / 1000}s)`,
        "Waiting for timer to fire (fake-201 will deliver OK; fake-410 triggers auto-delete)...",
      );
      const finalState = await pollUntil<SystemState>(
        () => getSystemState(config),
        (state) => findLatestSentTraceId(state, userId) !== null,
        POLL_TIMEOUT_MS,
        POLL_INTERVAL_MS,
      );

      const traceId = findLatestSentTraceId(finalState, userId)!;
      reporter.step(`notification.sent found traceId=${traceId}`);

      // ── Step 7: Assert fake-201 delivered successfully ─────────────────
      reporter.step("Assert: push.send.result success=true (fake-201 sub delivered)");
      assertNotificationSentSuccess(finalState, userId, traceId);

      // ── Step 8: Assert fake-410 was auto-deleted ───────────────────────
      // Give the server a moment for the async deleteSubscription call to commit.
      await new Promise((r) => setTimeout(r, 1_000));
      const stateAfterCleanup = await getSystemState(config);
      const subsAfterCleanup = stateAfterCleanup.subscriptionCounts[userId] ?? 0;
      const expectedAfterCleanup = baselineSubs + 1; // fake-201 stays; fake-410 gone

      reporter.step(
        `Subscription count after push: ${subsAfterCleanup}` +
        ` (expected ${expectedAfterCleanup}: fake-410 auto-deleted, fake-201 still present)`,
      );
      if (subsAfterCleanup !== expectedAfterCleanup) {
        throw new Error(
          `Expected fake-410 subscription to be auto-deleted after 410 response ` +
          `(count should be ${expectedAfterCleanup}), but got ${subsAfterCleanup}. ` +
          `The 410 cleanup path in pushService.ts may not have fired.`,
        );
      }

      fakeEndpoint410 = null; // already cleaned up by the 410 auto-delete

      reporter.step("Assert: no new anomalies");
      assertNoNewAnomalies(baseline, stateAfterCleanup, "subscription lifecycle");

      reporter.pass(subscriptionFlow.name);
    } catch (e) {
      reporter.fail(subscriptionFlow.name, e);
      throw e;
    } finally {
      if (ctx.sessionId) {
        await apiFetch(config, "PATCH", `/sessions/${ctx.sessionId}`, {}).catch(() => {});
      }
      // Clean up any fake subscriptions that weren't already removed by the
      // 410 auto-delete or the test assertions.
      const cleanupSubs = [fakeEndpoint410, fakeEndpoint201].filter(Boolean) as string[];
      await Promise.all(
        cleanupSubs.map((ep) =>
          apiFetch(config, "DELETE", "/push/subscribe", { endpoint: ep }).catch(() => {}),
        ),
      );
      if (ctx.savedSittingAlertMinutes !== null) {
        await apiFetch(config, "PATCH", "/settings", {
          sittingAlertMinutes: ctx.savedSittingAlertMinutes,
        }).catch(() => {});
      }
    }
  },
};
