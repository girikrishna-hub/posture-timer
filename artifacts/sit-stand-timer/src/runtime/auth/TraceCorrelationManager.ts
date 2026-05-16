/**
 * TraceCorrelationManager — assigns correlation IDs to auth operations.
 *
 * Every auth operation (boot, sign-in, refresh, recovery, lifecycle event)
 * receives a set of IDs that allow a complete auth flow to be reconstructed
 * from the diagnostics journal, even across process restarts.
 *
 * IDs are short random hex strings — readable in logs without being noisy.
 */

export interface TraceContext {
  /** Stable for the entire app process lifetime. Changes on cold start. */
  bootSessionId: string;
  /** Unique per auth operation (sign-in, sign-out, refresh). */
  operationId: string;
  /** Stable through a refresh chain (initial + all retries). */
  refreshChainId: string;
  /** Set for operations triggered by an app lifecycle event. */
  lifecycleEventId: string | null;
  /** Set for operations triggered by a recovery attempt. */
  recoveryAttemptId: string | null;
}

function shortId(): string {
  return Math.random().toString(16).slice(2, 10);
}

export class TraceCorrelationManager {
  private readonly _bootSessionId: string;
  private _currentRefreshChainId: string;
  private _currentLifecycleEventId: string | null = null;
  private _currentRecoveryAttemptId: string | null = null;

  constructor() {
    this._bootSessionId = shortId();
    this._currentRefreshChainId = shortId();
  }

  /** Boot session ID — stable for this process lifetime. */
  get bootSessionId(): string {
    return this._bootSessionId;
  }

  /**
   * Build a TraceContext for a new operation.
   * Each call generates a fresh operationId.
   */
  newOperation(opts?: {
    newRefreshChain?: boolean;
    newLifecycleEvent?: boolean;
    newRecoveryAttempt?: boolean;
  }): TraceContext {
    if (opts?.newRefreshChain) {
      this._currentRefreshChainId = shortId();
    }
    if (opts?.newLifecycleEvent) {
      this._currentLifecycleEventId = shortId();
    }
    if (opts?.newRecoveryAttempt) {
      this._currentRecoveryAttemptId = shortId();
    }

    return {
      bootSessionId: this._bootSessionId,
      operationId: shortId(),
      refreshChainId: this._currentRefreshChainId,
      lifecycleEventId: this._currentLifecycleEventId,
      recoveryAttemptId: this._currentRecoveryAttemptId,
    };
  }

  /** Clear lifecycle event ID after the event is fully processed. */
  clearLifecycleEvent(): void {
    this._currentLifecycleEventId = null;
  }

  /** Clear recovery attempt ID after recovery completes or fails. */
  clearRecoveryAttempt(): void {
    this._currentRecoveryAttemptId = null;
  }

  /**
   * Format a trace context as a compact string for log prefixes.
   * Example: [boot=a1b2c3d4 op=e5f6 refresh=7890 lc=abcd]
   */
  static format(ctx: TraceContext): string {
    const parts = [
      `boot=${ctx.bootSessionId}`,
      `op=${ctx.operationId}`,
      `ref=${ctx.refreshChainId}`,
    ];
    if (ctx.lifecycleEventId) parts.push(`lc=${ctx.lifecycleEventId}`);
    if (ctx.recoveryAttemptId) parts.push(`rec=${ctx.recoveryAttemptId}`);
    return `[${parts.join(" ")}]`;
  }
}
