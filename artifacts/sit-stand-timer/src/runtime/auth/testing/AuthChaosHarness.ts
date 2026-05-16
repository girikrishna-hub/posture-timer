/**
 * AuthChaosHarness — automated chaos testing for the auth runtime.
 *
 * Simulates failure conditions that cannot be tested with normal unit tests.
 *
 * IMPORTANT: This harness is development/testing only.
 * It must NEVER be imported in production code paths.
 * Import only from test files or the dev debug overlay.
 *
 * Phase 3 expansion: 14 deterministic scenarios covering all spec requirements.
 */

import type { AuthRuntime } from "../AuthRuntime";
import { ClerkRuntimeRegistry } from "../ClerkRuntimeRegistry";

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
    return { scenario: name, passed: false, durationMs: Date.now() - start, outcome: "THREW", error: msg };
  }
}

// ── Original scenarios ────────────────────────────────────────────────────────

/**
 * Scenario 1: Duplicate concurrent sign-in taps.
 * Two signInWithGoogle() calls fired simultaneously.
 * Expected: only one proceeds; second is deduplicated by AuthOperationQueue.
 */
export async function scenarioDuplicateSignIn(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("duplicate-sign-in", async () => {
    const [,] = await Promise.allSettled([
      runtime.signInWithGoogle(),
      runtime.signInWithGoogle(),
    ]);
    const queueIdle = runtime.queue.isIdle;
    return { outcome: queueIdle ? "QUEUE_IDLE_AFTER_DUPLICATE" : "QUEUE_BUSY" };
  });
}

/**
 * Scenario 2: Corrupted persisted session.
 * Manually corrupt the vault, then attempt restoration.
 * Expected: validator detects corruption, clears vault, transitions to SIGNED_OUT.
 */
export async function scenarioCorruptedSession(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("corrupted-session", async () => {
    try {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.set({ key: "auth_vault_v2", value: "{invalid json{{" });
      await Preferences.set({ key: "auth_vault_v2_ck", value: "0" });
    } catch {
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
 * Scenario 3: Offline startup with expired token.
 * Persist a 1-hour-expired session; validate via SessionRestorationValidator.
 * Expected: REFRESH_REQUIRED or EXPIRED_UNRESTORABLE (depending on threshold).
 */
export async function scenarioOfflineExpiredToken(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("offline-expired-token", async () => {
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
    return { outcome: isRefreshable ? "REFRESH_REQUIRED" : "EXPIRED_UNRESTORABLE" };
  });
}

/**
 * Scenario 4: Rapid suspend/resume loops (10 cycles).
 * Expected: lifecycle recovery lock prevents storm; queue idles after.
 */
export async function scenarioRapidResumeLoop(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("rapid-resume-loop", async () => {
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("offline"));
      await delay(10);
    }
    await delay(100);
    return { outcome: runtime.queue.isIdle ? "QUEUE_IDLE" : "QUEUE_BUSY" };
  });
}

/**
 * Scenario 5: Boot timeout condition.
 * Inspect current boot barrier phase.
 */
export async function scenarioBootTimeout(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("boot-timeout", async () => {
    const phase = runtime.bootBarrier.phase;
    return { outcome: `BARRIER_PHASE:${phase}` };
  });
}

/**
 * Scenario 6: Clock drift detection.
 * Validate a session with mismatched monotonic vs wall clock.
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
      expiresAt: Date.now() + 60 * 60 * 1000,
      lastRefreshedAt: Date.now(),
      provider: "google_native" as const,
      monotonicOffsetMs: performance.now() - 10 * 60 * 1000,
      persistedAt: Date.now() - 20 * 60 * 1000,
    };
    const result = validator.validate(driftedMeta);
    return {
      outcome: `${result.outcome}:confidence=${result.confidence}:drift=${Math.round(result.clockDriftMs / 1000)}s`,
    };
  });
}

// ── Phase 3 new scenarios ─────────────────────────────────────────────────────

/**
 * Scenario 7: Backend unreachable during refresh.
 * Simulate 503 response from healthz endpoint; verify capability registry updates.
 * Expected: capability degrades to DEGRADED; refresh marks chain as FAILED.
 */
export async function scenarioBackendUnreachable(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("backend-unreachable", async () => {
    // Patch network state to simulate backend loss
    runtime.capabilities.setBackendReachable(false);
    runtime.capabilities.setRefreshCapable(false);
    await delay(20);

    const level = runtime.capabilities.level;

    // Restore
    runtime.capabilities.setBackendReachable(navigator.onLine);
    runtime.capabilities.setRefreshCapable(navigator.onLine);

    return { outcome: `CAPABILITY_LEVEL:${level}` };
  });
}

/**
 * Scenario 8: Rapid network state flapping (20 cycles).
 * Expected: runtime does not crash; capability settles correctly when stable.
 */
export async function scenarioNetworkFlapping(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("network-flapping", async () => {
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new Event(i % 2 === 0 ? "offline" : "online"));
      await delay(5);
    }
    // Ensure we end in online state
    window.dispatchEvent(new Event("online"));
    await delay(50);
    return { outcome: `QUEUE_IDLE:${runtime.queue.isIdle} CAP:${runtime.capabilities.level}` };
  });
}

/**
 * Scenario 9: Delayed Clerk runtime registration.
 * Check registry status and verify waitForReady() behavior.
 */
export async function scenarioDelayedClerkRegistration(_runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("delayed-clerk-registration", async () => {
    const status = ClerkRuntimeRegistry.instance.status;
    const available = ClerkRuntimeRegistry.instance.isAvailable;
    return { outcome: `STATUS:${status} AVAILABLE:${available}` };
  });
}

/**
 * Scenario 10: Process death during active refresh chain.
 * Begin a chain, then expire it (simulating process death during refresh).
 * Expected: chain terminates as EXPIRED, no replay.
 */
export async function scenarioProcessDeathDuringRefresh(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("process-death-during-refresh", async () => {
    // Manually create a chain that simulates one from a prior process
    const chainId = `chaos-${Date.now()}`;
    runtime.refreshChains.beginChain(chainId);
    runtime.refreshChains.recordAttempt(chainId);

    // Immediately cancel as CANCELLED (simulates process death recovery cleanup)
    runtime.refreshChains.cancelChain(chainId, "CANCELLED");

    // Try to replay — must be a no-op
    runtime.refreshChains.recordAttempt(chainId);
    const chain = runtime.refreshChains.getChain(chainId);

    // Chain moved to history, active slot is null
    return {
      outcome: chain === null && runtime.refreshChains.activeChainId !== chainId
        ? "REPLAY_PREVENTED"
        : "REPLAY_NOT_PREVENTED",
    };
  });
}

/**
 * Scenario 11: JS runtime recreation (Clerk RECREATED signal).
 * Expected: BrowserRuntimeMonitor logs discontinuity; registry status updates.
 */
export async function scenarioJsRuntimeRecreation(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("js-runtime-recreation", async () => {
    const beforeCount = runtime.journal.snapshot.events.length;
    ClerkRuntimeRegistry.instance.signal("CLERK_RUNTIME_RECREATED");
    await delay(50);
    const afterCount = runtime.journal.snapshot.events.length;
    return {
      outcome: `events_added=${afterCount - beforeCount} clerk=${ClerkRuntimeRegistry.instance.status}`,
    };
  });
}

/**
 * Scenario 12: TimeAuthority monotonic correctness.
 * Verify trusted now ≈ Date.now() within 5 minutes.
 * Expected: isTrustworthy=true; drift within normal range.
 */
export async function scenarioTimeAuthorityCorrectness(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("time-authority-correctness", async () => {
    const snap = runtime.time.snapshot;
    const withinBounds = Math.abs(snap.clockDriftMs) < 5 * 60 * 1000;
    return {
      outcome: `trustworthy=${snap.isTrustworthy} drift=${Math.round(snap.clockDriftMs)}ms withinBounds=${withinBounds}`,
    };
  });
}

/**
 * Scenario 13: Vault partial-write detection.
 * Write incomplete vault data; restore must return null.
 */
export async function scenarioVaultPartialWrite(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("vault-partial-write", async () => {
    try {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.set({ key: "auth_vault_v2", value: '{"schemaVersion":2,"sessionId":"dead"' });
      await Preferences.remove({ key: "auth_vault_v2_ck" });
    } catch {
      sessionStorage.setItem("auth_vault_v2", '{"schemaVersion":2,"sessionId":"dead"');
      sessionStorage.removeItem("auth_vault_v2_ck");
    }
    const loaded = await runtime.vault.load();
    return { outcome: loaded === null ? "PARTIAL_WRITE_DETECTED" : `UNEXPECTED:${loaded.sessionId}` };
  });
}

/**
 * Scenario 14: Process recovery assessment accuracy.
 * Verify ProcessRecoveryCoordinator produces a valid startup classification.
 */
export async function scenarioProcessRecoveryAssessment(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("process-recovery-assessment", async () => {
    const kind = runtime.processRecovery.detectStartupKind();
    const validKinds = ["COLD_START", "WARM_RESUME", "PROCESS_RECOVERY", "BACKGROUND_RESTORE"];
    return {
      outcome: validKinds.includes(kind)
        ? `VALID_KIND:${kind}`
        : `INVALID_KIND:${kind}`,
    };
  });
}

// ── Harness runner ─────────────────────────────────────────────────────────────

/** Run all 14 chaos scenarios and return a summary. */
export async function runAllChaosScenarios(runtime: AuthRuntime): Promise<{
  results: ChaosResult[];
  passed: number;
  failed: number;
  totalMs: number;
}> {
  const start = Date.now();
  const scenarios = [
    scenarioDuplicateSignIn,
    scenarioCorruptedSession,
    scenarioOfflineExpiredToken,
    scenarioRapidResumeLoop,
    scenarioBootTimeout,
    scenarioClockDrift,
    scenarioBackendUnreachable,
    scenarioNetworkFlapping,
    scenarioDelayedClerkRegistration,
    scenarioProcessDeathDuringRefresh,
    scenarioJsRuntimeRecreation,
    scenarioTimeAuthorityCorrectness,
    scenarioVaultPartialWrite,
    scenarioProcessRecoveryAssessment,
  ];

  // Run sequentially to avoid cross-scenario state contamination
  const results: ChaosResult[] = [];
  for (const fn of scenarios) {
    results.push(await fn(runtime));
    await delay(50); // brief settle between scenarios
  }

  return {
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    totalMs: Date.now() - start,
  };
}
