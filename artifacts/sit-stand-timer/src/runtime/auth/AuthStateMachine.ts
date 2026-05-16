/**
 * AuthStateMachine — explicit FSM for authentication lifecycle.
 *
 * States model every real condition an auth runtime encounters:
 * cold start, session restoration, refresh, degradation, recovery, failure.
 *
 * Transitions are validated — invalid ones throw rather than silently corrupt.
 */

export type AuthState =
  | "UNINITIALIZED"
  | "INITIALIZING"
  | "RESTORING_SESSION"
  | "SIGNED_OUT"
  | "SIGNING_IN"
  | "SIGNED_IN"
  | "DEGRADED"
  | "OFFLINE_RECOVERY"
  | "EXPIRED"
  | "RECOVERING"
  | "FAILED";

// REMOVED: REFRESHING — was in VALID_TRANSITIONS but AuthSessionManager never
//   triggered it. Refresh happens silently via AuthOperationQueue without
//   surfacing as a distinct FSM state. Removing prevents future dead-branch bugs.
//
// REMOVED: PROCESS_RECOVERY — was in VALID_TRANSITIONS but AuthRuntime never
//   transitioned to it. Process recovery is handled by ProcessRecoveryCoordinator
//   at startup and mapped to RESTORING_SESSION → SIGNED_IN/DEGRADED directly.
//   The StartupMode enum still retains "PROCESS_RECOVERY" for classification.

export type StartupMode =
  | "COLD_START"
  | "WARM_RESUME"
  | "PROCESS_RECOVERY"
  | "OFFLINE_STARTUP"
  | "BACKGROUND_RESTORE"
  | "NETWORK_RECONNECT";

export interface AuthStateSnapshot {
  state: AuthState;
  previousState: AuthState | null;
  startupMode: StartupMode;
  enteredAt: number;
  transitionCount: number;
}

export type AuthStateListener = (snapshot: AuthStateSnapshot) => void;

// Valid transitions: from → Set<to>
// Every entry here must be exercised by production code.
// Run AuthStateTransitionReport to verify no dead states exist.
const VALID_TRANSITIONS: Record<AuthState, ReadonlySet<AuthState>> = {
  UNINITIALIZED:     new Set(["INITIALIZING"]),
  INITIALIZING:      new Set(["RESTORING_SESSION", "SIGNED_OUT", "FAILED"]),
  RESTORING_SESSION: new Set(["SIGNED_IN", "SIGNED_OUT", "EXPIRED", "DEGRADED", "OFFLINE_RECOVERY", "FAILED"]),
  SIGNED_OUT:        new Set(["SIGNING_IN"]),
  SIGNING_IN:        new Set(["SIGNED_IN", "SIGNED_OUT", "FAILED"]),
  SIGNED_IN:         new Set(["EXPIRED", "SIGNED_OUT", "DEGRADED", "FAILED"]),
  DEGRADED:          new Set(["RECOVERING", "SIGNED_OUT", "FAILED", "SIGNED_IN"]),
  OFFLINE_RECOVERY:  new Set(["SIGNED_IN", "SIGNED_OUT", "DEGRADED", "FAILED"]),
  EXPIRED:           new Set(["RECOVERING", "SIGNED_OUT", "OFFLINE_RECOVERY", "FAILED"]),
  RECOVERING:        new Set(["SIGNED_IN", "SIGNED_OUT", "DEGRADED", "FAILED"]),
  FAILED:            new Set(["INITIALIZING", "SIGNED_OUT"]),
};

export class AuthStateMachine {
  private _state: AuthState = "UNINITIALIZED";
  private _previousState: AuthState | null = null;
  private _startupMode: StartupMode = "COLD_START";
  private _enteredAt: number = Date.now();
  private _transitionCount: number = 0;
  private _listeners: Set<AuthStateListener> = new Set();

  get state(): AuthState { return this._state; }
  get snapshot(): AuthStateSnapshot {
    return {
      state: this._state,
      previousState: this._previousState,
      startupMode: this._startupMode,
      enteredAt: this._enteredAt,
      transitionCount: this._transitionCount,
    };
  }

  setStartupMode(mode: StartupMode): void {
    this._startupMode = mode;
  }

  transition(to: AuthState, context?: string): void {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.has(to)) {
      throw new Error(
        `[AuthStateMachine] Invalid transition: ${this._state} → ${to}` +
        (context ? ` (${context})` : "")
      );
    }
    this._previousState = this._state;
    this._state = to;
    this._enteredAt = Date.now();
    this._transitionCount++;
    this._notify();
  }

  /** Transition only if valid — no-op otherwise. Safe for fire-and-forget callers. */
  tryTransition(to: AuthState, context?: string): boolean {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.has(to)) return false;
    this.transition(to, context);
    return true;
  }

  subscribe(listener: AuthStateListener): () => void {
    this._listeners.add(listener);
    listener(this.snapshot);
    return () => this._listeners.delete(listener);
  }

  private _notify(): void {
    const snap = this.snapshot;
    for (const l of this._listeners) {
      try { l(snap); } catch { /* listener errors must not break state machine */ }
    }
  }
}
