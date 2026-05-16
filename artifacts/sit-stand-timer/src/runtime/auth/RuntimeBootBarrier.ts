/**
 * RuntimeBootBarrier — prevents the app from rendering feature UI until
 * auth restoration has resolved deterministically.
 *
 * React renders a blank/loading screen until the barrier clears.
 * The barrier self-clears on timeout to avoid hanging the app indefinitely
 * in degraded conditions (offline startup, backend unreachable).
 */

export type BootPhase =
  | "WAITING"        // barrier not yet cleared
  | "CLEARED"        // auth restored normally
  | "TIMEOUT"        // cleared by timeout (degraded mode)
  | "ERROR";         // cleared by unrecoverable error

export interface BootBarrierSnapshot {
  phase: BootPhase;
  clearedAt: number | null;
  elapsed: number;
  timedOut: boolean;
}

export type BootBarrierListener = (snap: BootBarrierSnapshot) => void;

export class RuntimeBootBarrier {
  private _phase: BootPhase = "WAITING";
  private _clearedAt: number | null = null;
  private _startedAt: number = Date.now();
  private _timeoutId: ReturnType<typeof setTimeout> | null = null;
  private _listeners: Set<BootBarrierListener> = new Set();
  private _resolveWait: (() => void) | null = null;
  private _waitPromise: Promise<void>;

  constructor(timeoutMs = 8000) {
    this._waitPromise = new Promise<void>((resolve) => {
      this._resolveWait = resolve;
    });

    this._timeoutId = setTimeout(() => {
      if (this._phase === "WAITING") {
        this._clear("TIMEOUT");
        console.warn(
          `[RuntimeBootBarrier] Auth restoration timed out after ${timeoutMs}ms — ` +
          "clearing in degraded mode",
        );
      }
    }, timeoutMs);
  }

  get phase(): BootPhase { return this._phase; }
  get isCleared(): boolean { return this._phase !== "WAITING"; }

  get snapshot(): BootBarrierSnapshot {
    return {
      phase: this._phase,
      clearedAt: this._clearedAt,
      elapsed: Date.now() - this._startedAt,
      timedOut: this._phase === "TIMEOUT",
    };
  }

  /** Called when auth restoration completes (success or failure) */
  clear(reason: "success" | "error" = "success"): void {
    this._clear(reason === "error" ? "ERROR" : "CLEARED");
  }

  /** Wait until the barrier clears (or times out). */
  wait(): Promise<void> {
    return this._waitPromise;
  }

  subscribe(fn: BootBarrierListener): () => void {
    this._listeners.add(fn);
    fn(this.snapshot);
    return () => this._listeners.delete(fn);
  }

  private _clear(phase: BootPhase): void {
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
