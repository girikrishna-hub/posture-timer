/**
 * AuthLifecycleCoordinator — responds to app lifecycle events.
 *
 * Handles foreground resume, background, network reconnect, and process
 * recovery. Verifies auth validity on each resume and triggers refresh
 * if needed, without causing duplicate refresh storms.
 *
 * All operations are serialized via AuthOperationQueue.
 */

import { App as CapacitorApp } from "@capacitor/app";
import type { AuthStateMachine } from "./AuthStateMachine";
import type { AuthStateStore } from "./AuthStateStore";
import type { AuthOperationQueue } from "./AuthOperationQueue";
import type { AuthSessionManager } from "./AuthSessionManager";
import type { AuthCapabilityRegistry } from "./AuthCapabilityRegistry";
import type { AuthDiagnosticsJournal } from "./AuthDiagnosticsJournal";

const STALE_SESSION_THRESHOLD_MS = 5 * 60 * 1000;

export class AuthLifecycleCoordinator {
  private _cleanups: Array<() => void> = [];
  private _lastForegroundAt = 0;

  constructor(
    private readonly _fsm: AuthStateMachine,
    private readonly _store: AuthStateStore,
    private readonly _queue: AuthOperationQueue,
    private readonly _sessionMgr: AuthSessionManager,
    private readonly _capabilities: AuthCapabilityRegistry,
    private readonly _journal: AuthDiagnosticsJournal,
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
    }).catch(() => { /* not native */ });

    // Network events
    const onOnline = () => {
      this._capabilities.setNetwork(true);
      this._journal.record("AUTH_RECOVERY_STARTED",
        "Network reconnected — checking session validity");
      this._onNetworkReconnect();
    };
    const onOffline = () => {
      this._capabilities.setNetwork(false);
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
  }

  private _onForegroundResume(): void {
    const now = Date.now();
    const timeSinceLast = now - this._lastForegroundAt;
    this._lastForegroundAt = now;

    this._journal.record("AUTH_RECOVERY_STARTED",
      `App foregrounded after ${Math.round(timeSinceLast / 1000)}s`);

    if (!this._store.session) return;
    if (!this._queue.isIdle) return;

    this._queue.enqueue(async () => {
      const session = this._store.session;
      if (!session) return;

      const msUntilExpiry = session.expiresAt - Date.now();
      const isStale = msUntilExpiry < STALE_SESSION_THRESHOLD_MS;
      const isExpired = msUntilExpiry <= 0;

      if (isExpired) {
        this._journal.record("AUTH_EXPIRED", "Session expired during background");
        this._fsm.tryTransition("EXPIRED", "lifecycle-resume");
        return;
      }
      if (isStale) {
        this._journal.record("AUTH_REFRESH_STARTED",
          "Session stale on resume — triggering early refresh");
        this._sessionMgr.scheduleRefresh();
      } else {
        this._journal.record("AUTH_SESSION_RESTORED",
          `Session valid for ${Math.round(msUntilExpiry / 60000)} more min`);
      }
    }, "lifecycle-resume");
  }

  private _onBackground(): void {
    this._journal.record("AUTH_RECOVERY_STARTED", "App backgrounded");
  }

  private _onNetworkReconnect(): void {
    if (!this._store.session) return;
    this._queue.enqueue(async () => {
      const session = this._store.session;
      if (!session) return;
      const isStale = session.expiresAt - Date.now() < STALE_SESSION_THRESHOLD_MS;
      if (isStale) {
        this._sessionMgr.scheduleRefresh();
      }
    }, "network-reconnect");
  }
}
