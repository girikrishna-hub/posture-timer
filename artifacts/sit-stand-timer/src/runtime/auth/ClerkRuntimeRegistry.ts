/**
 * ClerkRuntimeRegistry — event-driven Clerk SDK readiness signaling.
 *
 * Replaces all polling of window.Clerk.loaded across the codebase.
 * There is ONE internal watcher (50ms interval) inside the registry.
 * Every other system uses the promise-based waitForReady() API.
 *
 * ClerkRuntimeBridge signals the registry from its useEffect, providing
 * an explicit React-layer confirmation in addition to the internal watcher.
 *
 * Clerk runtime capability states:
 *   PENDING                  — not yet initialised
 *   CLERK_RUNTIME_AVAILABLE  — Clerk JS loaded and operational
 *   CLERK_RUNTIME_DELAYED    — loading but taking > delayMs (warn threshold)
 *   CLERK_RUNTIME_TIMEOUT    — never became available within timeoutMs
 *   CLERK_RUNTIME_UNAVAILABLE — load attempt failed (network/CSP)
 *   CLERK_RUNTIME_RECREATED  — was available, then re-initialised (WebView recovery)
 */

export type ClerkRuntimeStatus =
  | "PENDING"
  | "CLERK_RUNTIME_AVAILABLE"
  | "CLERK_RUNTIME_DELAYED"
  | "CLERK_RUNTIME_TIMEOUT"
  | "CLERK_RUNTIME_UNAVAILABLE"
  | "CLERK_RUNTIME_RECREATED";

export type ClerkRuntimeListener = (status: ClerkRuntimeStatus) => void;

export class ClerkRuntimeRegistry {
  private static _instance: ClerkRuntimeRegistry | null = null;

  static get instance(): ClerkRuntimeRegistry {
    if (!ClerkRuntimeRegistry._instance) {
      ClerkRuntimeRegistry._instance = new ClerkRuntimeRegistry();
    }
    return ClerkRuntimeRegistry._instance;
  }

  /** Reset singleton — for testing only. */
  static _reset(): void {
    ClerkRuntimeRegistry._instance?._teardown();
    ClerkRuntimeRegistry._instance = null;
  }

  private _status: ClerkRuntimeStatus = "PENDING";
  private _readyPromise: Promise<boolean>;
  private _resolve!: (v: boolean) => void;
  private _watchInterval: ReturnType<typeof setInterval> | null = null;
  private _delayTimer: ReturnType<typeof setTimeout> | null = null;
  private _timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private _listeners: Set<ClerkRuntimeListener> = new Set();
  private _becameAvailableAt: number | null = null;
  private _wasAvailable = false;

  /** @param delayMs — after this ms emit DELAYED if still PENDING */
  /** @param timeoutMs — after this ms terminate as TIMEOUT */
  private constructor(delayMs = 3_000, timeoutMs = 10_000) {
    this._readyPromise = new Promise<boolean>((resolve) => {
      this._resolve = resolve;
    });

    // Check immediately
    if (this._checkLoaded()) return;

    // Delayed status
    this._delayTimer = setTimeout(() => {
      if (this._status === "PENDING") this._setStatus("CLERK_RUNTIME_DELAYED");
    }, delayMs);

    // Timeout
    this._timeoutTimer = setTimeout(() => {
      if (!this._wasAvailable) this._onTimeout();
    }, timeoutMs);

    // Single internal watcher — the ONLY place in RuntimeCore that polls window.Clerk
    this._watchInterval = setInterval(() => {
      this._checkLoaded();
    }, 50);
  }

  get status(): ClerkRuntimeStatus { return this._status; }
  get isAvailable(): boolean {
    return this._status === "CLERK_RUNTIME_AVAILABLE" ||
           this._status === "CLERK_RUNTIME_RECREATED";
  }
  get becameAvailableAt(): number | null { return this._becameAvailableAt; }

  /**
   * Promise-based readiness wait.
   * Resolves true when Clerk becomes available; false on timeout.
   * Each caller gets the same promise — no duplicated polling.
   */
  async waitForReady(timeoutMs?: number): Promise<boolean> {
    if (this.isAvailable) return true;
    if (this._status === "CLERK_RUNTIME_TIMEOUT" ||
        this._status === "CLERK_RUNTIME_UNAVAILABLE") return false;

    if (timeoutMs === undefined) return this._readyPromise;

    return Promise.race([
      this._readyPromise,
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), timeoutMs)
      ),
    ]);
  }

  /**
   * Explicit signal from ClerkRuntimeBridge (runs inside InternalClerkProvider).
   * Called when the React layer confirms Clerk is operational.
   */
  signal(status: "CLERK_RUNTIME_AVAILABLE" | "CLERK_RUNTIME_RECREATED" = "CLERK_RUNTIME_AVAILABLE"): void {
    if (status === "CLERK_RUNTIME_RECREATED") {
      this._setStatus("CLERK_RUNTIME_RECREATED");
      this._resolve(true);
      return;
    }
    this._onAvailable();
  }

  /**
   * Signal that Clerk became unavailable (e.g. WebView recreation).
   * Resets the registry so it will wait for re-availability.
   */
  signalUnavailable(): void {
    this._setStatus("CLERK_RUNTIME_UNAVAILABLE");
    // Reset promise for next waitForReady() call
    this._readyPromise = new Promise<boolean>((resolve) => {
      this._resolve = resolve;
    });
    this._wasAvailable = false;
  }

  subscribe(fn: ClerkRuntimeListener): () => void {
    this._listeners.add(fn);
    fn(this._status);
    return () => this._listeners.delete(fn);
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private _checkLoaded(): boolean {
    if ((window as unknown as { Clerk?: { loaded?: boolean } }).Clerk?.loaded) {
      this._onAvailable();
      return true;
    }
    return false;
  }

  private _onAvailable(): void {
    this._clearWatchers();
    const wasAlreadyAvailable = this._wasAvailable;
    this._wasAvailable = true;
    this._becameAvailableAt = Date.now();
    this._setStatus(
      wasAlreadyAvailable ? "CLERK_RUNTIME_RECREATED" : "CLERK_RUNTIME_AVAILABLE"
    );
    this._resolve(true);
  }

  private _onTimeout(): void {
    this._clearWatchers();
    this._setStatus("CLERK_RUNTIME_TIMEOUT");
    this._resolve(false);
  }

  private _setStatus(s: ClerkRuntimeStatus): void {
    this._status = s;
    for (const l of this._listeners) {
      try { l(s); } catch { /* never propagate */ }
    }
  }

  private _clearWatchers(): void {
    if (this._watchInterval) { clearInterval(this._watchInterval); this._watchInterval = null; }
    if (this._delayTimer)    { clearTimeout(this._delayTimer);    this._delayTimer = null; }
    if (this._timeoutTimer)  { clearTimeout(this._timeoutTimer);  this._timeoutTimer = null; }
  }

  private _teardown(): void {
    this._clearWatchers();
    this._listeners.clear();
  }
}
