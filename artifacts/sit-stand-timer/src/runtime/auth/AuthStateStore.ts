/**
 * AuthStateStore — single operational source of truth for runtime auth state.
 *
 * Holds the mutable, observable auth state that React observes but does NOT own.
 * All mutations go through AuthRuntime; the store is read-only from React's
 * perspective.
 */

export type AuthCapability = "FULL" | "DEGRADED" | "OFFLINE_ONLY" | "UNAVAILABLE";

export interface RuntimeSession {
  /** Clerk session ID */
  sessionId: string;
  /** Clerk user ID */
  userId: string;
  /** JWT for API calls */
  jwt: string;
  /** Unix ms when the JWT expires */
  expiresAt: number;
  /** Unix ms of last successful refresh */
  lastRefreshedAt: number;
  /** How the session was established */
  provider: "google_native" | "google_web" | "email_password";
}

export interface AuthStoreState {
  session: RuntimeSession | null;
  capability: AuthCapability;
  /** True once the initial restore attempt has completed (success or failure) */
  isRestored: boolean;
  /** Human-readable description of current degradation, if any */
  degradationReason: string | null;
  /** Number of consecutive refresh failures */
  refreshFailures: number;
  /** Unix ms of last failed refresh attempt */
  lastRefreshFailedAt: number | null;
  /** Whether the device is believed to be online */
  isOnline: boolean;
}

export type StoreListener = (state: AuthStoreState) => void;

const INITIAL: AuthStoreState = {
  session: null,
  capability: "UNAVAILABLE",
  isRestored: false,
  degradationReason: null,
  refreshFailures: 0,
  lastRefreshFailedAt: null,
  isOnline: true,
};

export class AuthStateStore {
  private _state: AuthStoreState = { ...INITIAL };
  private _listeners: Set<StoreListener> = new Set();

  get state(): AuthStoreState { return { ...this._state }; }
  get session(): RuntimeSession | null { return this._state.session; }
  get isAuthenticated(): boolean { return this._state.session !== null; }
  get isRestored(): boolean { return this._state.isRestored; }
  get capability(): AuthCapability { return this._state.capability; }

  patch(partial: Partial<AuthStoreState>): void {
    this._state = { ...this._state, ...partial };
    this._notify();
  }

  setSession(session: RuntimeSession | null): void {
    this.patch({
      session,
      capability: session ? "FULL" : "UNAVAILABLE",
      refreshFailures: 0,
      degradationReason: null,
    });
  }

  recordRefreshFailure(): void {
    this.patch({
      refreshFailures: this._state.refreshFailures + 1,
      lastRefreshFailedAt: Date.now(),
      capability: this._state.refreshFailures >= 2 ? "DEGRADED" : this._state.capability,
    });
  }

  subscribe(listener: StoreListener): () => void {
    this._listeners.add(listener);
    listener(this.state);
    return () => this._listeners.delete(listener);
  }

  private _notify(): void {
    const state = this.state;
    for (const l of this._listeners) {
      try { l(state); } catch { /* never let listener errors propagate */ }
    }
  }
}
