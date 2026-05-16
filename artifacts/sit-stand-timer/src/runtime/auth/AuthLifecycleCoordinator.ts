/**
 * AuthLifecycleCoordinator — responds to app lifecycle events.
 *
 * Handles foreground resume, background, network reconnect, and process
 * recovery. Verifies auth validity on each resume and triggers refresh
 * if needed.
 *
 * PHASE 5 ADDITIONS:
 *
 * Degraded→Available Recovery Gap (closed):
 *   When Clerk transport transitions from unavailable → available while the
 *   runtime is in DEGRADED or OFFLINE_RECOVERY, an automatic recovery is
 *   triggered. This is debounced, lock-guarded, and idempotent.
 *   Transport availability does NOT imply auth success — recovery still
 *   validates session viability before changing state.
 *
 * Lifecycle Suspension Tracking:
 *   onSuspend() / onResume() forwarded to AuthSessionManager for
 *   RefreshChainCoordinator lifecycle interruption recording.
 *
 * INVARIANTS:
 * - LifecycleRecoveryLock prevents storms from rapid lifecycle events
 * - All operations are queue-controlled and trace-tagged
 * - Recovery is idempotent — duplicate triggers are deduplicated
 * - Transport recovery has a deterministic termination (max retries from
 *   underlying RefreshChain; transport recovery itself fires at most once
 *   per transport-available transition)
 */

import { App as CapacitorApp } from "@capacitor/app";
import type { AuthStateMachine } from "./AuthStateMachine";
import type { AuthStateStore } from "./AuthStateStore";
import type { AuthOperationQueue } from "./AuthOperationQueue";
import type { AuthSessionManager } from "./AuthSessionManager";
import type { AuthCapabilityRegistry, CapabilitySnapshot } from "./AuthCapabilityRegistry";
import type { AuthDiagnosticsJournal } from "./AuthDiagnosticsJournal";
import type { TraceCorrelationManager } from "./TraceCorrelationManager";
import { LifecycleRecoveryLock } from "./LifecycleRecoveryLock";

const STALE_SESSION_THRESHOLD_MS = 5 * 60 * 1000;
const MIN_FOREGROUND_REFRESH_GAP_MS = 30_000;
/** Debounce duration before acting on a transport-available signal */
const TRANSPORT_RECOVERY_DEBOUNCE_MS = 300;
/** Clerk refresh-window: 24 hours past JWT expiry */
const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export class AuthLifecycleCoordinator {
  private _cleanups: Array<() => void> = [];
  private _lastForegroundAt = 0;
  private _lastRefreshTriggeredAt = 0;
  private readonly _lock = new LifecycleRecoveryLock(30_000);

  // Transport recovery gap tracking
  private _prevClerkTransportAvailable = false;
  private _transportRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly _fsm: AuthStateMachine,
    private readonly _store: AuthStateStore,
    private readonly _queue: AuthOperationQueue,
    private readonly _sessionMgr: AuthSessionManager,
    private readonly _capabilities: AuthCapabilityRegistry,
    private readonly _journal: AuthDiagnosticsJournal,
    private readonly _trace: TraceCorrelationManager,
  ) {}

  /** Register all lifecycle listeners. Call once during runtime boot. */
  attach(): void {
    // Capacitor app state changes
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) {
        this._onForegroundResume();
      } else {
        this._onBackground();
      }
    }).then((handle) => {
      this._cleanups.push(() => handle.remove());
    }).catch(() => { /* not native — OK */ });

    // Network events
    const onOnline = () => {
      this._capabilities.setNetwork(true);
      this._store.patch({ isOnline: true });
      this._onNetworkReconnect();
    };
    const onOffline = () => {
      this._capabilities.setNetwork(false);
      this._store.patch({ isOnline: false });
      this._journal.record("AUTH_DEGRADED", "Network lost — entering offline mode");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    this._cleanups.push(() => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    });

    // ── Degraded→Available Recovery Gap (Phase 5) ───────────────────────────
    // Subscribe to capability changes to detect when Clerk transport becomes
    // available while the runtime is in a degraded state.
    const initialCap = this._capabilities.snapshot;
    this._prevClerkTransportAvailable = initialCap.clerkTransportAvailable;

    const capUnsub = this._capabilities.subscribe((cap) => {
      this._onCapabilityChange(cap);
    });
    this._cleanups.push(() => {
      capUnsub();
      if (this._transportRecoveryTimer !== null) {
        clearTimeout(this._transportRecoveryTimer);
        this._transportRecoveryTimer = null;
      }
    });
  }

  detach(): void {
    for (const fn of this._cleanups) { try { fn(); } catch { /* ignore */ } }
    this._cleanups = [];
    this._lock.forceRelease();
  }

  // ── Lifecycle handlers ────────────────────────────────────────────────────

  private _onForegroundResume(): void {
    const now = Date.now();
    const timeSinceLast = now - this._lastForegroundAt;
    this._lastForegroundAt = now;

    // Notify session manager for RefreshChain lifecycle recording
    this._sessionMgr.onResume();

    const ctx = this._trace.newOperation({ newLifecycleEvent: true });

    this._journal.record("AUTH_RECOVERY_STARTED",
      `App foregrounded after ${Math.round(timeSinceLast / 1000)}s`);

    if (!this._store.session) {
      this._trace.clearLifecycleEvent();
      return;
    }

    const token = this._lock.tryAcquire("foreground-resume");
    if (!token) {
      this._journal.record("AUTH_RECOVERY_STARTED",
        `Lifecycle recovery in progress (held ${this._lock.heldForMs}ms) — skipping`);
      this._trace.clearLifecycleEvent();
      return;
    }

    const timeSinceLastRefresh = now - this._lastRefreshTriggeredAt;
    if (timeSinceLastRefresh < MIN_FOREGROUND_REFRESH_GAP_MS && this._store.session) {
      this._journal.record("AUTH_SESSION_RESTORED",
        `Foreground refresh rate-limited (last triggered ${Math.round(timeSinceLastRefresh / 1000)}s ago)`);
      this._lock.release(token);
      this._trace.clearLifecycleEvent();
      return;
    }

    void this._queue.enqueue(async () => {
      try {
        const session = this._store.session;
        if (!session) return;

        const msUntilExpiry = session.expiresAt - Date.now();
        const isStale = msUntilExpiry < STALE_SESSION_THRESHOLD_MS;
        const isExpired = msUntilExpiry <= 0;

        if (isExpired) {
          this._journal.record("AUTH_EXPIRED",
            `Session expired during background (op=${ctx.operationId})`);
          this._fsm.tryTransition("EXPIRED", "lifecycle-resume");
          return;
        }
        if (isStale) {
          this._journal.record("AUTH_REFRESH_STARTED",
            `Session stale on resume — triggering refresh (op=${ctx.operationId})`);
          this._lastRefreshTriggeredAt = Date.now();
          this._sessionMgr.scheduleRefresh();
        } else {
          this._journal.record("AUTH_SESSION_RESTORED",
            `Session valid for ${Math.round(msUntilExpiry / 60000)} more min (op=${ctx.operationId})`);
        }
      } finally {
        this._lock.release(token);
        this._trace.clearLifecycleEvent();
      }
    }, "lifecycle-resume");
  }

  private _onBackground(): void {
    this._journal.record("AUTH_RECOVERY_STARTED", "App backgrounded");
    // Record suspension in session manager for RefreshChain lifecycle tracking
    this._sessionMgr.onSuspend();
  }

  private _onNetworkReconnect(): void {
    const ctx = this._trace.newOperation({ newLifecycleEvent: true });
    this._journal.record("AUTH_RECOVERY_STARTED",
      `Network reconnected — checking session validity (op=${ctx.operationId})`);

    if (!this._store.session) {
      this._trace.clearLifecycleEvent();
      return;
    }

    const token = this._lock.tryAcquire("network-reconnect");
    if (!token) {
      this._journal.record("AUTH_RECOVERY_STARTED",
        "Recovery already in progress — skipping network-reconnect trigger");
      this._trace.clearLifecycleEvent();
      return;
    }

    void this._queue.enqueue(async () => {
      try {
        const session = this._store.session;
        if (!session) return;
        const isStale = session.expiresAt - Date.now() < STALE_SESSION_THRESHOLD_MS;
        if (isStale) {
          this._lastRefreshTriggeredAt = Date.now();
          this._sessionMgr.scheduleRefresh();
        }
      } finally {
        this._lock.release(token);
        this._trace.clearLifecycleEvent();
      }
    }, "network-reconnect");
  }

  // ── Transport-available recovery (Phase 5 gap fix) ──────────────────────

  /**
   * Called on every capability snapshot change.
   * Detects the clerkTransportAvailable false → true transition
   * while in a degraded auth state, and schedules a debounced recovery.
   */
  private _onCapabilityChange(cap: CapabilitySnapshot): void {
    const wasAvailable = this._prevClerkTransportAvailable;
    const isNowAvailable = cap.clerkTransportAvailable;
    this._prevClerkTransportAvailable = isNowAvailable;

    // Only act on false → true transition
    if (wasAvailable || !isNowAvailable) return;

    // Only trigger if in a degraded state that recovery can help
    const state = this._fsm.state;
    if (state !== "DEGRADED" && state !== "OFFLINE_RECOVERY") return;

    // Debounce — Clerk may emit multiple rapid signals during initialization
    if (this._transportRecoveryTimer !== null) {
      clearTimeout(this._transportRecoveryTimer);
    }
    this._transportRecoveryTimer = setTimeout(() => {
      this._transportRecoveryTimer = null;
      this._onTransportBecameAvailable();
    }, TRANSPORT_RECOVERY_DEBOUNCE_MS);
  }

  /**
   * Triggered after debounce when Clerk transport becomes available
   * while auth is DEGRADED or OFFLINE_RECOVERY.
   *
   * Invariants:
   * - Idempotent: lock prevents concurrent transport recoveries
   * - Bounded: underlying refresh chain has MAX_RETRY_ATTEMPTS=3
   * - Deterministic termination: session outside refresh window → SIGNED_OUT
   * - Non-storming: exactly one timer per false→true transition
   * - Validates before acting: checks session viability, not just transport
   */
  private _onTransportBecameAvailable(): void {
    // Re-check state synchronously — may have changed during debounce
    const state = this._fsm.state;
    if (state !== "DEGRADED" && state !== "OFFLINE_RECOVERY") return;

    const snap = this._store.state;

    // Already at full confidence — nothing to recover
    if (snap.confidence === "VERIFIED" || snap.confidence === "RECOVERED") return;

    // Check lock — do not storm if another recovery is running
    const token = this._lock.tryAcquire("transport-available");
    if (!token) {
      this._journal.record("AUTH_RECOVERY_STARTED",
        "Transport became available but recovery lock held — will retry on next lifecycle event");
      return;
    }

    const session = this._store.session;
    if (!session) {
      this._lock.release(token);
      return;
    }

    const ctx = this._trace.newOperation({ newLifecycleEvent: true });
    this._journal.record("AUTH_RECOVERY_STARTED",
      `Clerk transport available — initiating degraded→active recovery (state=${state} op=${ctx.operationId})`);

    void this._queue.enqueue(async () => {
      try {
        const current = this._store.session;
        if (!current) return;

        // Validate session is still within Clerk refresh window
        const withinRefreshWindow = current.expiresAt + REFRESH_WINDOW_MS > Date.now();
        if (!withinRefreshWindow) {
          this._journal.record("AUTH_SIGN_OUT_COMPLETED",
            `Session beyond refresh window — forcing sign-out (op=${ctx.operationId})`);
          this._fsm.tryTransition("SIGNED_OUT", "transport-recovery-session-too-old");
          return;
        }

        // Session is recoverable — trigger refresh
        this._lastRefreshTriggeredAt = Date.now();
        this._sessionMgr.scheduleRefresh();

        this._journal.record("AUTH_RECOVERY_COMPLETED",
          `Transport recovery scheduled for user (op=${ctx.operationId})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this._journal.record("AUTH_RECOVERY_COMPLETED",
          `Transport recovery failed: ${msg} — remaining degraded`);
      } finally {
        this._lock.release(token);
        this._trace.clearLifecycleEvent();
      }
    }, "transport-recovery");
  }
}
