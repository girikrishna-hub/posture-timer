/**
 * TimeAuthority — monotonic, drift-safe time source for auth operations.
 *
 * The device wall clock (Date.now()) cannot be trusted alone:
 * - Users can change the system clock manually
 * - Android suspend introduces wall-clock drift vs monotonic time
 * - Timezone changes can shift absolute time unexpectedly
 * - Long offline periods may accumulate significant drift
 *
 * TimeAuthority uses performance.now() (monotonic) anchored to a wall-clock
 * baseline established at construction to provide a "trusted now" that is:
 * - Immune to manual clock changes after startup
 * - Suspend-duration-aware via explicit resume notifications
 * - Reconciled against server time when available
 *
 * Callers use now() instead of Date.now() for expiry checks.
 */

export interface TimeSnapshot {
  trustedNow: number;
  wallNow: number;
  clockDriftMs: number;
  suspendDurationMs: number;
  serverOffsetMs: number;
  isTrustworthy: boolean;
  suspendCount: number;
}

const MAX_TOLERABLE_DRIFT_MS = 5 * 60 * 1000;  // 5 minutes
const SUSPECT_DRIFT_MS = 60 * 1000;             // 1 minute — warn threshold

export class TimeAuthority {
  private static _instance: TimeAuthority | null = null;
  static get instance(): TimeAuthority {
    if (!TimeAuthority._instance) TimeAuthority._instance = new TimeAuthority();
    return TimeAuthority._instance;
  }

  private readonly _monotonicAnchor: number;   // performance.now() at construction
  private readonly _wallAnchor: number;         // Date.now() at construction
  private _serverOffsetMs = 0;                  // server_time - local_time
  private _totalSuspendMs = 0;                  // total ms spent suspended
  private _lastSuspendAt: number | null = null; // monotonic time of last suspend
  private _suspendCount = 0;

  private constructor() {
    this._monotonicAnchor = performance.now();
    this._wallAnchor = Date.now();
  }

  /**
   * "Trusted now" — monotonically anchored to startup time.
   * Immune to post-startup wall clock changes.
   * Adjusted for server time offset and suspend duration.
   */
  now(): number {
    const monotonicElapsed = performance.now() - this._monotonicAnchor;
    return this._wallAnchor + monotonicElapsed + this._serverOffsetMs;
  }

  /**
   * Clock drift between wall clock and monotonic estimate (ms).
   * Positive = wall clock is ahead; negative = behind.
   */
  clockDriftMs(): number {
    return Date.now() - this.now();
  }

  /** True if the device clock appears trustworthy (drift within tolerance). */
  isClockTrustworthy(): boolean {
    return Math.abs(this.clockDriftMs()) < MAX_TOLERABLE_DRIFT_MS;
  }

  /** True if drift is large enough to warrant a warning. */
  hasSuspectDrift(): boolean {
    return Math.abs(this.clockDriftMs()) > SUSPECT_DRIFT_MS;
  }

  /**
   * Call on app resume (foreground event) to account for suspend duration.
   * Android process suspension pauses performance.now() but not Date.now(),
   * creating drift. This records the true suspend duration.
   */
  onResume(): { suspendDurationMs: number } {
    if (this._lastSuspendAt !== null) {
      const monotonicResume = performance.now();
      const wallSuspendDuration = Date.now() - (this._wallAnchor + (this._lastSuspendAt - this._monotonicAnchor));
      const monotonicSuspendDuration = monotonicResume - this._lastSuspendAt;
      // The gap between wall-time elapsed and monotonic elapsed is the suspend duration
      const suspendMs = Math.max(0, wallSuspendDuration - monotonicSuspendDuration);
      this._totalSuspendMs += suspendMs;
      this._lastSuspendAt = null;
      this._suspendCount++;
      return { suspendDurationMs: suspendMs };
    }
    return { suspendDurationMs: 0 };
  }

  /** Call when app goes to background. */
  onSuspend(): void {
    this._lastSuspendAt = performance.now();
  }

  /**
   * Reconcile against a server-provided timestamp.
   * Computes the offset and applies it to now().
   */
  reconcileWithServer(serverTimestampMs: number): { offsetMs: number } {
    const localNow = this.now();
    this._serverOffsetMs = serverTimestampMs - localNow;
    return { offsetMs: this._serverOffsetMs };
  }

  /**
   * Safe expiry check — accounts for clock drift.
   * Returns true if the token is still valid with an optional leeway.
   */
  isNotExpired(expiresAtMs: number, leewayMs = 30_000): boolean {
    return this.now() < expiresAtMs - leewayMs;
  }

  /**
   * How many ms remain until expiry (negative if already expired).
   * Uses trusted now.
   */
  msUntilExpiry(expiresAtMs: number): number {
    return expiresAtMs - this.now();
  }

  get snapshot(): TimeSnapshot {
    return {
      trustedNow: this.now(),
      wallNow: Date.now(),
      clockDriftMs: this.clockDriftMs(),
      suspendDurationMs: this._totalSuspendMs,
      serverOffsetMs: this._serverOffsetMs,
      isTrustworthy: this.isClockTrustworthy(),
      suspendCount: this._suspendCount,
    };
  }
}
