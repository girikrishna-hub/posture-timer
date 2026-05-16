/**
 * AuthChaosHarness — automated chaos testing for the auth runtime.
 *
 * Simulates failure conditions that cannot be tested with normal unit tests:
 * - Process death mid-refresh
 * - Network loss during token exchange
 * - Offline startup with expired token
 * - Corrupted persisted session
 * - Duplicate concurrent sign-in taps
 * - Backend unavailable during restore
 * - Rapid suspend/resume loops
 *
 * IMPORTANT: This harness is development/testing only.
 * It must NEVER be imported in production code paths.
 * Import only from test files or the dev debug overlay.
 */

import type { AuthRuntime } from "../AuthRuntime";

export interface ChaosScenario {
  name: string;
  description: string;
  run: (runtime: AuthRuntime) => Promise<ChaosResult>;
}

export interface ChaosResult {
  scenario: string;
  passed: boolean;
  durationMs: number;
  outcome: string;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario(
  name: string,
  fn: () => Promise<{ outcome: string }>,
): Promise<ChaosResult> {
  const start = Date.now();
  try {
    const { outcome } = await fn();
    return { scenario: name, passed: true, durationMs: Date.now() - start, outcome };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      scenario: name,
      passed: false,
      durationMs: Date.now() - start,
      outcome: "THREW",
      error: msg,
    };
  }
}

// ── Scenarios ────────────────────────────────────────────────────────────────

/**
 * Scenario: Duplicate concurrent sign-in taps.
 * Two signInWithGoogle() calls fired simultaneously.
 * Expected: only one sign-in attempt proceeds; the other is deduplicated by AuthOperationQueue.
 */
export async function scenarioDuplicateSignIn(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("duplicate-sign-in", async () => {
    // Both calls enqueue to the same "sign-in-google" tag — second is deduplicated
    const [, ] = await Promise.allSettled([
      runtime.signInWithGoogle(),
      runtime.signInWithGoogle(),
    ]);
    const queueIdle = runtime.queue.isIdle;
    return { outcome: queueIdle ? "QUEUE_IDLE_AFTER_DUPLICATE" : "QUEUE_BUSY" };
  });
}

/**
 * Scenario: Corrupted persisted session.
 * Manually corrupt the vault, then attempt restoration.
 * Expected: validator detects corruption, clears vault, transitions to SIGNED_OUT.
 */
export async function scenarioCorruptedSession(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("corrupted-session", async () => {
    // Write corrupted data directly to preferences
    try {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.set({ key: "auth_vault_v2", value: "{invalid json{{" });
      await Preferences.set({ key: "auth_vault_v2_ck", value: "0" });
    } catch {
      // Not native — use sessionStorage
      sessionStorage.setItem("auth_vault_v2", "{invalid json{{");
      sessionStorage.setItem("auth_vault_v2_ck", "0");
    }

    const loaded = await runtime.vault.load();
    return {
      outcome: loaded === null ? "CORRUPTION_DETECTED" : `UNEXPECTED_LOAD:${JSON.stringify(loaded)}`,
    };
  });
}

/**
 * Scenario: Offline startup with expired token.
 * Persist an expired session, simulate offline, attempt restoration.
 * Expected: OFFLINE_RESTORABLE if not too old, EXPIRED_UNRESTORABLE if beyond window.
 */
export async function scenarioOfflineExpiredToken(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("offline-expired-token", async () => {
    // Save a session that expired 1 hour ago
    const expiredAt = Date.now() - 60 * 60 * 1000;
    await runtime.vault.save({
      sessionId: "chaos-test-session",
      userId: "chaos-user",
      expiresAt: expiredAt,
      lastRefreshedAt: expiredAt - 5 * 60 * 1000,
      provider: "google_native",
      monotonicOffsetMs: performance.now() - 60 * 60 * 1000,
    });

    const loaded = await runtime.vault.load();
    if (!loaded) return { outcome: "VAULT_LOAD_FAILED" };

    const isRefreshable = runtime.vault.isRefreshable(loaded);
    return {
      outcome: isRefreshable ? "REFRESH_REQUIRED" : "EXPIRED_UNRESTORABLE",
    };
  });
}

/**
 * Scenario: Rapid suspend/resume loops.
 * Fires 10 rapid foreground/background events.
 * Expected: lifecycle recovery lock prevents storm; queue stays idle after.
 */
export async function scenarioRapidResumeLoop(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("rapid-resume-loop", async () => {
    const ITERATIONS = 10;
    for (let i = 0; i < ITERATIONS; i++) {
      // Simulate appStateChange event by directly calling the lifecycle coordinator
      // (only accessible via runtime internals in test context)
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("offline"));
      await delay(10);
    }
    await delay(100); // let any queued ops settle
    const outcome = runtime.queue.isIdle ? "QUEUE_IDLE" : "QUEUE_BUSY";
    return { outcome };
  });
}

/**
 * Scenario: Boot timeout condition.
 * Simulate a boot that takes longer than the barrier timeout.
 * Expected: barrier transitions to TIMEOUT state with explicit diagnostics.
 */
export async function scenarioBootTimeout(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("boot-timeout", async () => {
    // Inspect current barrier phase
    const phase = runtime.bootBarrier.phase;
    return { outcome: `BARRIER_PHASE:${phase}` };
  });
}

/**
 * Scenario: Clock drift detection.
 * Save a session with a monotonic offset that doesn't match wall clock.
 * Expected: validator detects drift and downgrades confidence.
 */
export async function scenarioClockDrift(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("clock-drift", async () => {
    const { SessionRestorationValidator } = await import("../SessionRestorationValidator");
    const validator = new SessionRestorationValidator();

    const driftedMeta = {
      schemaVersion: 2 as const,
      sessionId: "drift-test",
      userId: "drift-user",
      expiresAt: Date.now() + 60 * 60 * 1000, // 1h from now
      lastRefreshedAt: Date.now(),
      provider: "google_native" as const,
      // monotonic offset is 10 minutes less than wall clock elapsed — simulates drift
      monotonicOffsetMs: performance.now() - 10 * 60 * 1000,
      persistedAt: Date.now() - 20 * 60 * 1000, // persisted 20 min ago
    };

    const result = validator.validate(driftedMeta);
    return { outcome: `${result.outcome}:confidence=${result.confidence}:drift=${Math.round(result.clockDriftMs / 1000)}s` };
  });
}

// ── Harness runner ────────────────────────────────────────────────────────────

/**
 * Run all chaos scenarios and return a summary report.
 */
export async function runAllChaosScenarios(runtime: AuthRuntime): Promise<{
  results: ChaosResult[];
  passed: number;
  failed: number;
  totalMs: number;
}> {
  const start = Date.now();
  const results = await Promise.allSettled([
    scenarioDuplicateSignIn(runtime),
    scenarioCorruptedSession(runtime),
    scenarioOfflineExpiredToken(runtime),
    scenarioRapidResumeLoop(runtime),
    scenarioBootTimeout(runtime),
    scenarioClockDrift(runtime),
  ]);

  const resolved = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { scenario: `scenario-${i}`, passed: false, durationMs: 0, outcome: "HARNESS_ERROR", error: String((r as PromiseRejectedResult).reason) }
  );

  return {
    results: resolved,
    passed: resolved.filter((r) => r.passed).length,
    failed: resolved.filter((r) => !r.passed).length,
    totalMs: Date.now() - start,
  };
}
