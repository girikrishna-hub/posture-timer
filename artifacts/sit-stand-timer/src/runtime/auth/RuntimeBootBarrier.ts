/**
 * RuntimeBootBarrier — prevents the app from rendering feature UI until
 * auth restoration has resolved deterministically.
 *
 * HARDENED: Boot now terminates ONLY into explicit, semantically meaningful
 * states. "Continue anyway after timeout" is forbidden — every timeout is
 * classified and logged as an explicit FSM state transition.
 *
 * Terminal states:
 *   AUTHENTICATED    — session established and verified
 *   UNAUTHENTICATED  — no session; user must sign in
 *   DEGRADED         — session known but refresh failed; partial operation
 *   OFFLINE_RECOVERY — session restored from cache; device offline
 *   FAILED           — unrecoverable boot error
 *
 * On timeout the barrier does NOT just "continue" — it records diagnostics
 * and terminates into FAILED (the runtime then decides whether to attempt
 * UNAUTHENTICATED or stay in an error state).
 */

export type BootPhase =
  | "WAITING"           // barrier not yet cleared (initial state only)
  | "AUTHENTICATED"     // boot complete — session verified
  | "UNAUTHENTICATED"   // boot complete — no session, sign-in required
  | "DEGRADED"          // boot complete — session degraded (stale/partial)
  | "OFFLINE_RECOVERY"  // boot complete — session from cache, device offline
  | "FAILED";           // boot failed — unrecoverable error

export type BootTerminalPhase = Exclude<BootPhase, "WAITING">;

export interface BootBarrierSnapshot {
  phase: BootPhase;
  clearedAt: number | null;
  elapsed: number;
  /** True if boot terminated due to timeout rather than explicit resolution */
  timedOut: boolean;
  /** True once barrier has cleared (any terminal phase) */
  isCleared: boolean;
}

export type BootBarrierListener = (snap: BootBarrierSnapshot) => void;

export class RuntimeBootBarrier {
  private _phase: BootPhase = "WAITING";
  private _clearedAt: number | null = null;
  private _timedOut = false;
  private readonly _startedAt: number = Date.now();
  private _timeoutId: ReturnType<typeof setTimeout> | null = null;
  private _listeners: Set<BootBarrierListener> = new Set();
  private _resolveWait: (() => void) | null = null;
  private readonly _waitPromise: Promise<void>;

  constructor(timeoutMs = 8000) {
    this._waitPromise = new Promise<void>((resolve) => {
      this._resolveWait = resolve;
    });

    this._timeoutId = setTimeout(() => {
      if (this._phase !== "WAITING") return;
      this._timedOut = true;
      // Emit diagnostics but still terminate explicitly
      console.error(
        `[RuntimeBootBarrier] Auth restoration timed out after ${timeoutMs}ms. ` +
        "Terminating boot as FAILED. Check network connectivity and Clerk configuration."
      );
      this._terminate("FAILED");
    }, timeoutMs);
  }

  get phase(): BootPhase { return this._phase; }
  get isCleared(): boolean { return this._phase !== "WAITING"; }

  get snapshot(): BootBarrierSnapshot {
    return {
      phase: this._phase,
      clearedAt: this._clearedAt,
      elapsed: Date.now() - this._startedAt,
      timedOut: this._timedOut,
      isCleared: this._phase !== "WAITING",
    };
  }

  /**
   * Terminate the barrier with an explicit semantic outcome.
   * Each call is idempotent — subsequent calls for an already-cleared barrier are no-ops.
   */
  clear(phase: BootTerminalPhase): void {
    this._terminate(phase);
  }

  /**
   * Wait until the barrier clears (any terminal phase).
   */
  wait(): Promise<void> {
    return this._waitPromise;
  }

  subscribe(fn: BootBarrierListener): () => void {
    this._listeners.add(fn);
    fn(this.snapshot);
    return () => this._listeners.delete(fn);
  }

  private _terminate(phase: BootPhase): void {
    if (this._phase !== "WAITING") return;
    if (this._timeoutId !== null) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    this._phase = phase;
    this._clearedAt = Date.now();
    this._resolveWait?.();
    const snap = this.snapshot;
    for (const l of this._listeners) {
      try { l(snap); } catch { /* never propagate */ }
    }
  }
}
