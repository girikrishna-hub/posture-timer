/**
 * RefreshChainCoordinator — tracks refresh chain lifecycle for full reconstructability.
 *
 * Every token refresh belongs to a named chain. Chains:
 * - are identified by a unique chainId (from TraceCorrelationManager)
 * - survive lifecycle suspension (record interruptions, not failures)
 * - terminate deterministically into SUCCEEDED / FAILED / EXPIRED / CANCELLED
 * - are prevented from stale replay (chains older than maxChainAgeMs are expired)
 * - are deduplicated (only one active chain at a time)
 *
 * The chain history is available to AuthTraceVisualizer and the debug overlay.
 */

export type RefreshChainOutcome =
  | "PENDING"
  | "SUCCEEDED"
  | "FAILED"
  | "EXPIRED"      // chain aged out
  | "CANCELLED"    // superseded by a new chain (sign-out, sign-in)
  | "SUPERSEDED";  // a newer chain took over

export interface RefreshChain {
  chainId: string;
  startedAt: number;
  lastAttemptAt: number | null;
  completedAt: number | null;
  attemptCount: number;
  retryCount: number;
  suspendCount: number;
  totalSuspendMs: number;
  lifecycleInterruptions: string[];
  failureReasons: string[];
  outcome: RefreshChainOutcome;
}

const MAX_CHAIN_AGE_MS = 10 * 60 * 1000;  // 10 min — chains older than this are stale
const MAX_HISTORY = 20;

export class RefreshChainCoordinator {
  private _chains = new Map<string, RefreshChain>();
  private _activeChainId: string | null = null;
  private _history: RefreshChain[] = [];

  /** Begin a new refresh chain. Cancels any active chain. */
  beginChain(chainId: string): RefreshChain {
    // Cancel any existing active chain
    if (this._activeChainId && this._activeChainId !== chainId) {
      this.cancelChain(this._activeChainId, "SUPERSEDED");
    }

    const chain: RefreshChain = {
      chainId,
      startedAt: Date.now(),
      lastAttemptAt: null,
      completedAt: null,
      attemptCount: 0,
      retryCount: 0,
      suspendCount: 0,
      totalSuspendMs: 0,
      lifecycleInterruptions: [],
      failureReasons: [],
      outcome: "PENDING",
    };

    this._chains.set(chainId, chain);
    this._activeChainId = chainId;
    return chain;
  }

  /** Record a refresh attempt within a chain. */
  recordAttempt(chainId: string): void {
    const chain = this._chains.get(chainId);
    if (!chain || chain.outcome !== "PENDING") return;
    chain.attemptCount++;
    if (chain.attemptCount > 1) chain.retryCount++;
    chain.lastAttemptAt = Date.now();
  }

  /** Record an app lifecycle suspension during an active chain. */
  recordSuspend(chainId: string): void {
    const chain = this._chains.get(chainId);
    if (!chain || chain.outcome !== "PENDING") return;
    chain.suspendCount++;
    chain.lifecycleInterruptions.push(`suspend@${Date.now()}`);
  }

  /** Record app resume after suspension. */
  recordResume(chainId: string, suspendDurationMs: number): void {
    const chain = this._chains.get(chainId);
    if (!chain || chain.outcome !== "PENDING") return;
    chain.totalSuspendMs += suspendDurationMs;
    chain.lifecycleInterruptions.push(
      `resume@${Date.now()} (+${Math.round(suspendDurationMs / 1000)}s)`
    );
  }

  /** Record a failure reason within an active chain. */
  recordFailure(chainId: string, reason: string): void {
    const chain = this._chains.get(chainId);
    if (!chain || chain.outcome !== "PENDING") return;
    chain.failureReasons.push(reason);
  }

  /** Terminate chain successfully. */
  completeChain(chainId: string): void {
    this._terminateChain(chainId, "SUCCEEDED");
  }

  /** Terminate chain with failure. */
  failChain(chainId: string, reason?: string): void {
    if (reason) this.recordFailure(chainId, reason);
    this._terminateChain(chainId, "FAILED");
  }

  /** Cancel a chain (superseded or sign-out). */
  cancelChain(chainId: string, outcome: "CANCELLED" | "SUPERSEDED" = "CANCELLED"): void {
    this._terminateChain(chainId, outcome);
  }

  /**
   * Expire stale chains — call on resume to clean up chains interrupted by
   * process death or long suspension.
   */
  expireStaleChains(): string[] {
    const expired: string[] = [];
    for (const [id, chain] of this._chains) {
      if (chain.outcome !== "PENDING") continue;
      const age = Date.now() - chain.startedAt;
      if (age > MAX_CHAIN_AGE_MS) {
        this._terminateChain(id, "EXPIRED");
        expired.push(id);
      }
    }
    if (this._activeChainId && expired.includes(this._activeChainId)) {
      this._activeChainId = null;
    }
    return expired;
  }

  get activeChain(): RefreshChain | null {
    if (!this._activeChainId) return null;
    return this._chains.get(this._activeChainId) ?? null;
  }

  get activeChainId(): string | null { return this._activeChainId; }

  get history(): RefreshChain[] { return [...this._history]; }

  getChain(chainId: string): RefreshChain | null {
    return this._chains.get(chainId) ?? null;
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private _terminateChain(
    chainId: string,
    outcome: Exclude<RefreshChainOutcome, "PENDING">,
  ): void {
    const chain = this._chains.get(chainId);
    if (!chain || chain.outcome !== "PENDING") return;
    chain.outcome = outcome;
    chain.completedAt = Date.now();
    this._chains.delete(chainId);
    // Add to history, trim to MAX_HISTORY
    this._history = [chain, ...this._history].slice(0, MAX_HISTORY);
    if (this._activeChainId === chainId) this._activeChainId = null;
  }
}
