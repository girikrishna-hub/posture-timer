/**
 * AuthDiagnosticsJournal — structured, observable auth event log.
 *
 * All auth lifecycle events are written here. The RuntimeOverlay reads from
 * this journal to display the full auth trace without coupling to individual
 * runtime subsystems.
 */

import type { AuthState, StartupMode } from "./AuthStateMachine";
import type { AuthCapabilityLevel } from "./AuthCapabilityRegistry";

export type AuthEventKind =
  | "AUTH_INITIALIZED"
  | "AUTH_SESSION_RESTORED"
  | "AUTH_REFRESH_STARTED"
  | "AUTH_REFRESH_SUCCEEDED"
  | "AUTH_REFRESH_FAILED"
  | "AUTH_DEGRADED"
  | "AUTH_EXPIRED"
  | "AUTH_RECOVERY_STARTED"
  | "AUTH_RECOVERY_COMPLETED"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "AUTH_SIGN_OUT_COMPLETED"
  | "AUTH_SIGN_IN_STARTED"
  | "AUTH_SIGN_IN_SUCCEEDED"
  | "AUTH_SIGN_IN_FAILED"
  | "AUTH_STATE_TRANSITION"
  | "AUTH_CAPABILITY_CHANGED"
  | "AUTH_BOOT_BARRIER_CLEARED"
  | "AUTH_BOOT_TIMEOUT"
  | "AUTH_OPERATION_QUEUED"
  | "AUTH_ERROR";

export interface AuthEvent {
  id: number;
  kind: AuthEventKind;
  timestamp: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface DiagnosticsSnapshot {
  events: AuthEvent[];
  currentState: AuthState | null;
  startupMode: StartupMode | null;
  capability: AuthCapabilityLevel;
  sessionUserId: string | null;
  sessionExpiresAt: number | null;
  refreshFailures: number;
  lastRefreshAt: number | null;
  isRestored: boolean;
}

export class AuthDiagnosticsJournal {
  private _events: AuthEvent[] = [];
  private _counter = 0;
  private _currentState: AuthState | null = null;
  private _startupMode: StartupMode | null = null;
  private _capability: AuthCapabilityLevel = "UNAVAILABLE";
  private _sessionUserId: string | null = null;
  private _sessionExpiresAt: number | null = null;
  private _refreshFailures = 0;
  private _lastRefreshAt: number | null = null;
  private _isRestored = false;
  private _listeners: Set<(snap: DiagnosticsSnapshot) => void> = new Set();
  private readonly MAX_EVENTS = 100;

  record(kind: AuthEventKind, message: string, data?: Record<string, unknown>): void {
    const event: AuthEvent = {
      id: ++this._counter,
      kind,
      timestamp: Date.now(),
      message,
      data,
    };
    this._events = [event, ...this._events].slice(0, this.MAX_EVENTS);
    console.log(`[AuthJournal] ${kind}: ${message}`, data ?? "");
    this._notify();
  }

  updateState(state: AuthState, mode?: StartupMode): void {
    this._currentState = state;
    if (mode) this._startupMode = mode;
    this._notify();
  }

  updateCapability(level: AuthCapabilityLevel): void {
    this._capability = level;
    this._notify();
  }

  updateSession(
    userId: string | null,
    expiresAt: number | null,
    refreshFailures: number,
    lastRefreshAt: number | null,
    isRestored: boolean,
  ): void {
    this._sessionUserId = userId;
    this._sessionExpiresAt = expiresAt;
    this._refreshFailures = refreshFailures;
    this._lastRefreshAt = lastRefreshAt;
    this._isRestored = isRestored;
    this._notify();
  }

  get snapshot(): DiagnosticsSnapshot {
    return {
      events: [...this._events],
      currentState: this._currentState,
      startupMode: this._startupMode,
      capability: this._capability,
      sessionUserId: this._sessionUserId,
      sessionExpiresAt: this._sessionExpiresAt,
      refreshFailures: this._refreshFailures,
      lastRefreshAt: this._lastRefreshAt,
      isRestored: this._isRestored,
    };
  }

  subscribe(fn: (snap: DiagnosticsSnapshot) => void): () => void {
    this._listeners.add(fn);
    fn(this.snapshot);
    return () => this._listeners.delete(fn);
  }

  private _notify(): void {
    const snap = this.snapshot;
    for (const l of this._listeners) {
      try { l(snap); } catch { /* never propagate */ }
    }
  }
}
