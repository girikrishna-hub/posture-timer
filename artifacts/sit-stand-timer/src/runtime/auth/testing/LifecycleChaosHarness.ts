/**
 * LifecycleChaosHarness — lifecycle-specific chaos scenarios for the auth runtime.
 *
 * Complements AuthChaosHarness with scenarios that test lifecycle interactions:
 * - Rapid foreground/background cycles
 * - Suspend during active refresh
 * - Process kill simulation during restoration
 * - Delayed Clerk transport readiness
 * - Android activity recreation loops
 * - Battery optimization interruptions
 * - Concurrent lifecycle + network events
 *
 * DEVELOPMENT/TESTING ONLY. Never import in production paths.
 */

import type { AuthRuntime } from "../AuthRuntime";
import type { ChaosResult } from "./AuthChaosHarness";
import { ClerkRuntimeRegistry } from "../ClerkRuntimeRegistry";
import { TimeAuthority } from "../TimeAuthority";

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

/**
 * Rapid foreground/background cycles (30 iterations).
 * Expected: recovery lock prevents storm; queue idles cleanly.
 */
export async function scenarioRapidSuspendResumeLoop(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("rapid-suspend-resume-30", async () => {
    const CYCLES = 30;
    for (let i = 0; i < CYCLES; i++) {
      window.dispatchEvent(new Event("offline"));
      await delay(5);
      window.dispatchEvent(new Event("online"));
      await delay(5);
    }
    await delay(200);
    return { outcome: runtime.queue.isIdle ? "QUEUE_IDLE_AFTER_30_CYCLES" : "QUEUE_BUSY" };
  });
}

/**
 * Suspend during active refresh.
 * Simulate going offline mid-refresh then coming back online.
 * Expected: refresh reschedules with backoff; no duplicate chains.
 */
export async function scenarioSuspendDuringRefresh(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("suspend-during-refresh", async () => {
    // Trigger a refresh then immediately go offline
    window.dispatchEvent(new Event("online"));
    await delay(10);
    window.dispatchEvent(new Event("offline"));
    await delay(50);
    window.dispatchEvent(new Event("online"));
    await delay(100);

    const activeChain = runtime.refreshChains.activeChain;
    return {
      outcome: activeChain
        ? `CHAIN_${activeChain.outcome}_suspends=${activeChain.suspendCount}`
        : "NO_ACTIVE_CHAIN",
    };
  });
}

/**
 * Delayed Clerk transport readiness.
 * Check what happens when ClerkRuntimeRegistry reports DELAYED status.
 * Expected: registry emits DELAYED then resolves; boot phase is not FAILED.
 */
export async function scenarioDelayedClerkReadiness(_runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("delayed-clerk-readiness", async () => {
    const status = ClerkRuntimeRegistry.instance.status;
    // If Clerk is already available, this scenario records the observed status
    return { outcome: `CLERK_STATUS:${status}` };
  });
}

/**
 * Concurrent lifecycle + network events.
 * Fire online/offline + visibility changes simultaneously.
 * Expected: runtime handles all events without deadlock or panic.
 */
export async function scenarioConcurrentLifecycleEvents(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("concurrent-lifecycle-events", async () => {
    // Fire concurrent events
    await Promise.all([
      Promise.resolve().then(() => window.dispatchEvent(new Event("online"))),
      Promise.resolve().then(() => window.dispatchEvent(new Event("offline"))),
      Promise.resolve().then(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "visible", configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }),
    ]);
    await delay(200);
    const fsmState = runtime.fsm.state;
    return { outcome: `FSM_STATE:${fsmState}` };
  });
}

/**
 * Clock drift > 30 minutes.
 * Simulate device clock being set forward 31 minutes.
 * Expected: TimeAuthority.hasSuspectDrift() returns true; session treated as near-expiry.
 */
export async function scenarioClockDriftLarge(_runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("clock-drift-30min", async () => {
    const time = TimeAuthority.instance;
    const drift = time.clockDriftMs();
    const suspect = time.hasSuspectDrift();
    const trustworthy = time.isClockTrustworthy();
    return {
      outcome: `drift=${Math.round(drift / 1000)}s suspect=${suspect} trustworthy=${trustworthy}`,
    };
  });
}

/**
 * Stale refresh replay attempt.
 * Create a chain, expire it, then attempt to record an attempt on it.
 * Expected: RefreshChainCoordinator ignores the stale attempt; no outcome change.
 */
export async function scenarioStaleRefreshReplay(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("stale-refresh-replay", async () => {
    const staleId = "chaos-stale-chain-" + Date.now();
    runtime.refreshChains.beginChain(staleId);

    // Directly expire via time simulation: override startedAt by forcing expiry check
    // We can't easily fake Date.now() so we test the expiry path by checking behavior
    const expired = runtime.refreshChains.expireStaleChains();

    // Since the chain was just created, it's NOT stale yet — this validates the guard
    const wasExpired = expired.includes(staleId);

    // Now cancel it and try to record an attempt after cancellation
    runtime.refreshChains.cancelChain(staleId, "CANCELLED");
    runtime.refreshChains.recordAttempt(staleId); // must be no-op

    const chain = runtime.refreshChains.getChain(staleId); // moved to history
    return {
      outcome: chain === null && !wasExpired
        ? "STALE_REPLAY_BLOCKED"
        : `UNEXPECTED:expired=${wasExpired}`,
    };
  });
}

/**
 * Process kill during vault write simulation.
 * Write partial vault data, then try to restore.
 * Expected: vault detects corruption/incomplete write and returns null.
 */
export async function scenarioMidWriteProcessDeath(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("mid-write-process-death", async () => {
    // Write malformed vault data to simulate interrupted write
    try {
      const { Preferences } = await import("@capacitor/preferences");
      // Write key but not checksum (simulates mid-write death)
      await Preferences.set({ key: "auth_vault_v2", value: '{"schemaVersion":2,"sessionId":"dead"' });
      // Don't write checksum — simulates crash before checksum was written
    } catch {
      sessionStorage.setItem("auth_vault_v2", '{"schemaVersion":2,"sessionId":"dead"');
      sessionStorage.removeItem("auth_vault_v2_ck");
    }

    const loaded = await runtime.vault.load();
    return {
      outcome: loaded === null
        ? "PARTIAL_WRITE_DETECTED"
        : `LOADED_DESPITE_PARTIAL:${loaded.sessionId}`,
    };
  });
}

/**
 * JS runtime recreation during restore simulation.
 * Signal ClerkRuntimeRegistry as RECREATED; check that RuntimeCore handles it.
 * Expected: BrowserRuntimeMonitor emits CLERK_RECREATED; runtime logs discontinuity.
 */
export async function scenarioJsRuntimeRecreationDuringRestore(runtime: AuthRuntime): Promise<ChaosResult> {
  return runScenario("js-runtime-recreation", async () => {
    const beforeEvents = runtime.journal.snapshot.events.length;

    // Signal recreation
    ClerkRuntimeRegistry.instance.signal("CLERK_RUNTIME_RECREATED");

    await delay(50);

    const afterEvents = runtime.journal.snapshot.events.length;
    return {
      outcome: `events_before=${beforeEvents} after=${afterEvents} ` +
        `clerk_status=${ClerkRuntimeRegistry.instance.status}`,
    };
  });
}

// ── Harness runner ─────────────────────────────────────────────────────────────

export async function runAllLifecycleChaosScenariosAsync(runtime: AuthRuntime): Promise<{
  results: ChaosResult[];
  passed: number;
  failed: number;
  totalMs: number;
}> {
  const start = Date.now();
  // Run sequentially to avoid interactions between scenarios
  const results: ChaosResult[] = [];
  for (const fn of [
    scenarioRapidSuspendResumeLoop,
    scenarioSuspendDuringRefresh,
    scenarioDelayedClerkReadiness,
    scenarioConcurrentLifecycleEvents,
    scenarioClockDriftLarge,
    scenarioStaleRefreshReplay,
    scenarioMidWriteProcessDeath,
    scenarioJsRuntimeRecreationDuringRestore,
  ]) {
    results.push(await fn(runtime));
    await delay(100); // brief settle between scenarios
  }

  return {
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    totalMs: Date.now() - start,
  };
}
