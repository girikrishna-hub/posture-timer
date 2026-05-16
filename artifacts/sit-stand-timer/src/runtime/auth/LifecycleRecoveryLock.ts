/**
 * LifecycleRecoveryLock — prevents concurrent or duplicate lifecycle recoveries.
 *
 * The lock is intentionally not async/promise-based. It operates as a simple
 * mutex flag that must be explicitly released. Callers that fail to acquire
 * the lock skip their recovery attempt — the in-progress recovery is considered
 * sufficient for all simultaneous callers.
 *
 * Prevents:
 * - Refresh storms from rapid suspend/resume cycles
 * - Duplicate recoveries from simultaneous lifecycle events
 * - Recursive refresh loops (recovery triggering recovery)
 *
 * Usage:
 *   const id = lock.tryAcquire("resume");
 *   if (!id) return; // recovery already in progress
 *   try { ... recovery work ... } finally { lock.release(id); }
 */

export class LifecycleRecoveryLock {
  private _holderId: string | null = null;
  private _acquiredAt: number | null = null;
  private readonly _maxHoldMs: number;

  /**
   * @param maxHoldMs — Maximum time a lock can be held before auto-expiry.
   *   Prevents permanent lock if a recovery op crashes without releasing.
   *   Default: 30 seconds.
   */
  constructor(maxHoldMs = 30_000) {
    this._maxHoldMs = maxHoldMs;
  }

  /** True if the lock is currently held (and not expired). */
  get isLocked(): boolean {
    if (!this._holderId) return false;
    // Auto-expire stale locks
    if (this._acquiredAt !== null && Date.now() - this._acquiredAt > this._maxHoldMs) {
      this._holderId = null;
      this._acquiredAt = null;
      return false;
    }
    return true;
  }

  /** The ID of the current holder, or null. */
  get holderId(): string | null {
    return this.isLocked ? this._holderId : null;
  }

  /**
   * Try to acquire the lock.
   * Returns a lock token string on success, or null if the lock is held.
   *
   * @param reason — human-readable label for diagnostics (not used for uniqueness)
   */
  tryAcquire(reason: string): string | null {
    if (this.isLocked) return null;
    const token = `${reason}-${Date.now().toString(36)}`;
    this._holderId = token;
    this._acquiredAt = Date.now();
    return token;
  }

  /**
   * Release the lock.
   * Only the holder can release — wrong token is a no-op.
   */
  release(token: string): void {
    if (this._holderId === token) {
      this._holderId = null;
      this._acquiredAt = null;
    }
  }

  /**
   * Force-release regardless of holder.
   * Use only in error paths / shutdown.
   */
  forceRelease(): void {
    this._holderId = null;
    this._acquiredAt = null;
  }

  /** How long the lock has been held (ms), or 0 if not held. */
  get heldForMs(): number {
    if (!this._acquiredAt || !this.isLocked) return 0;
    return Date.now() - this._acquiredAt;
  }
}
