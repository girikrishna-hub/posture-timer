/**
 * AuthLifecycleCoordinator — responds to app lifecycle events.
 *
 * Handles foreground resume, background, network reconnect, and process
 * recovery. Verifies auth validity on each resume and triggers refresh
 * if needed.
 *
 * HARDENED:
 * - LifecycleRecoveryLock prevents refresh storms from rapid suspend/resume
 * - All operations are tagged with trace IDs via TraceCorrelationManager
 * - Concurrent lifecycle events are deduplicated — the in-progress recovery
 *   covers all simultaneous callers
 */

import { App as CapacitorApp } from "@capacitor/app";
import type { AuthStateMachine } from "./AuthStateMachine";
import type { AuthStateStore } from "./AuthStateStore";
import type { AuthOperationQueue } from "./AuthOperationQueue";
import type { AuthSessionManager } from "./AuthSessionManager";
import type { AuthCapabilityRegistry } from "./AuthCapabilityRegistry";
import type { AuthDiagnosticsJournal } from "./AuthDiagnosticsJournal";
import type { TraceCorrelationManager } from "./TraceCorrelationManager";
import { LifecycleRecoveryLock } from "./LifecycleRecoveryLock";

const STALE_SESSION_THRESHOLD_MS = 5 * 60 * 1000;
/** Minimum gap between foreground-triggered refreshes to prevent storms */
const MIN_FOREGROUND_REFRESH_GAP_MS = 30_000;

export class AuthLifecycleCoordinator {
  private _cleanups: Array<() => void> = [];
  private _lastForegroundAt = 0;
  private _lastRefreshTriggeredAt = 0;
  private readonly _lock = new LifecycleRecoveryLock(30_000);

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
    // Capacitor app state changes (foreground / background)
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
  }

  detach(): void {
    for (const fn of this._cleanups) { try { fn(); } catch { /* ignore */ } }
    this._cleanups = [];
    this._lock.forceRelease();
  }

  private _onForegroundResume(): void {
    const now = Date.now();
    const timeSinceLast = now - this._lastForegroundAt;
    this._lastForegroundAt = now;

    const ctx = this._trace.newOperation({ newLifecycleEvent: true });

    this._journal.record("AUTH_RECOVERY_STARTED",
      `App foregrounded after ${Math.round(timeSinceLast / 1000)}s`);

    if (!this._store.session) {
      this._trace.clearLifecycleEvent();
      return;
    }

    // Acquire lock — prevents storm from rapid suspend/resume cycles
    const token = this._lock.tryAcquire("foreground-resume");
    if (!token) {
      this._journal.record("AUTH_RECOVERY_STARTED",
        `Lifecycle recovery already in progress (held ${this._lock.heldForMs}ms) — skipping`);
      this._trace.clearLifecycleEvent();
      return;
    }

    // Rate-limit: don't trigger refresh more than once per MIN_FOREGROUND_REFRESH_GAP_MS
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
}
