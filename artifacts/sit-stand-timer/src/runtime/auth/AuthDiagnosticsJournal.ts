/**
 * AuthDiagnosticsJournal — structured, observable auth event log.
 *
 * All auth lifecycle events are written here. The RuntimeOverlay reads from
 * this journal to display the full auth trace without coupling to individual
 * runtime subsystems.
 *
 * SECURITY: console output is gated to DEV builds only.
 * Reason: journal messages can include user IDs and email addresses.
 * In production, these must not appear in Android logcat, which is readable
 * by other apps holding READ_LOGS permission or via ADB.
 *
 * OBSERVABILITY: Events are tagged with severity to allow the overlay to
 * filter noisy operational events (e.g. AUTH_STATE_TRANSITION fires on
 * every FSM change) from significant events (failures, sign-ins, degradation).
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

/**
 * CRITICAL — sign-in failures, unrecoverable errors, security events.
 * WARN     — degradation, refresh failures, capability changes.
 * INFO     — successful operations: sign-in, restore, boot complete.
 * VERBOSE  — high-frequency operational events: state transitions, queue ops.
 */
export type AuthEventSeverity = "CRITICAL" | "WARN" | "INFO" | "VERBOSE";

const KIND_SEVERITY: Record<AuthEventKind, AuthEventSeverity> = {
  AUTH_SIGN_IN_FAILED:       "CRITICAL",
  AUTH_ERROR:                "CRITICAL",
  AUTH_BOOT_TIMEOUT:         "CRITICAL",
  AUTH_REFRESH_FAILED:       "WARN",
  AUTH_DEGRADED:             "WARN",
  AUTH_EXPIRED:              "WARN",
  AUTH_PROVIDER_UNAVAILABLE: "WARN",
  AUTH_CAPABILITY_CHANGED:   "WARN",
  AUTH_INITIALIZED:          "INFO",
  AUTH_SESSION_RESTORED:     "INFO",
  AUTH_REFRESH_SUCCEEDED:    "INFO",
  AUTH_RECOVERY_COMPLETED:   "INFO",
  AUTH_SIGN_OUT_COMPLETED:   "INFO",
  AUTH_SIGN_IN_SUCCEEDED:    "INFO",
  AUTH_BOOT_BARRIER_CLEARED: "INFO",
  AUTH_REFRESH_STARTED:      "VERBOSE",
  AUTH_RECOVERY_STARTED:     "VERBOSE",
  AUTH_STATE_TRANSITION:     "VERBOSE",
  AUTH_OPERATION_QUEUED:     "VERBOSE",
  AUTH_SIGN_IN_STARTED:      "VERBOSE",
};

const SEVERITY_RANK: Record<AuthEventSeverity, number> = {
  CRITICAL: 0, WARN: 1, INFO: 2, VERBOSE: 3,
};

export interface AuthEvent {
  id: number;
  kind: AuthEventKind;
  severity: AuthEventSeverity;
  timestamp: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface DiagnosticsSnapshot {
  /** All events newest-first, up to MAX_EVENTS */
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

const IS_DEV = import.meta.env.DEV;
const MAX_EVENTS = 100;

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

  record(kind: AuthEventKind, message: string, data?: Record<string, unknown>): void {
    const severity = KIND_SEVERITY[kind];
    const event: AuthEvent = {
      id: ++this._counter,
      kind,
      severity,
      timestamp: Date.now(),
      message,
      data,
    };
    this._events = [event, ...this._events].slice(0, MAX_EVENTS);

    // SECURITY: only log to console in development builds.
    // In production, auth events must not appear in Android logcat.
    if (IS_DEV) {
      if (severity === "CRITICAL") {
        console.error(`[AuthJournal] ${kind}: ${message}`, data ?? "");
      } else if (severity === "WARN") {
        console.warn(`[AuthJournal] ${kind}: ${message}`, data ?? "");
      } else if (severity === "INFO") {
        console.info(`[AuthJournal] ${kind}: ${message}`, data ?? "");
      }
      // VERBOSE events are suppressed even in dev — too noisy for default console output
    }

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

  /**
   * Get a filtered snapshot containing only events at or above the given severity.
   * Useful for the overlay to show significant events by default.
   */
  snapshotAt(minSeverity: AuthEventSeverity): DiagnosticsSnapshot {
    const rank = SEVERITY_RANK[minSeverity];
    return {
      ...this.snapshot,
      events: this._events.filter((e) => SEVERITY_RANK[e.severity] <= rank),
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
