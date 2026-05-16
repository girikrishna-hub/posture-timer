/**
 * AuthSessionManager — single refresh authority.
 *
 * Owns token refresh scheduling, expiry tracking, retry backoff, and
 * offline-aware refresh logic. No other component may call getToken()
 * for refresh purposes — they read from AuthStateStore.
 */

import type { AuthStateStore } from "./AuthStateStore";
import type { AuthOperationQueue } from "./AuthOperationQueue";
import type { ClerkBridgeAdapter } from "./ClerkBridgeAdapter";
import type { AuthDiagnosticsJournal } from "./AuthDiagnosticsJournal";
import type { SecureSessionStore } from "./SecureSessionStore";

const REFRESH_BEFORE_EXPIRY_MS = 2 * 60 * 1000;  // refresh 2 min before expiry
const MAX_RETRY_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 5_000;

export class AuthSessionManager {
  private _timerId: ReturnType<typeof setTimeout> | null = null;
  private _retryAttempt = 0;
  private _destroyed = false;

  constructor(
    private readonly _store: AuthStateStore,
    private readonly _queue: AuthOperationQueue,
    private readonly _clerk: ClerkBridgeAdapter,
    private readonly _secure: SecureSessionStore,
    private readonly _journal: AuthDiagnosticsJournal,
  ) {}

  /** Start the refresh scheduler. Called after a session is established. */
  scheduleRefresh(): void {
    this._cancelScheduled();
    const session = this._store.session;
    if (!session) return;

    const msUntilExpiry = session.expiresAt - Date.now();
    const delay = Math.max(0, msUntilExpiry - REFRESH_BEFORE_EXPIRY_MS);

    this._journal.record("AUTH_REFRESH_STARTED",
      `Refresh scheduled in ${Math.round(delay / 1000)}s`,
      { expiresAt: session.expiresAt, delay });

    this._timerId = setTimeout(() => this._doRefresh(), delay);
  }

  /** Cancel any pending refresh timer. */
  cancelRefresh(): void {
    this._cancelScheduled();
    this._retryAttempt = 0;
  }

  destroy(): void {
    this._destroyed = true;
    this._cancelScheduled();
  }

  private async _doRefresh(): Promise<void> {
    if (this._destroyed) return;
    if (!navigator.onLine) {
      this._journal.record("AUTH_REFRESH_FAILED",
        "Skipping refresh — device is offline; will retry on reconnect");
      this._scheduleRetry();
      return;
    }

    await this._queue.enqueue(async () => {
      if (this._destroyed) return;
      try {
        this._journal.record("AUTH_REFRESH_STARTED", "Refreshing JWT…");
        const jwt = await this._clerk.refreshToken();
        const session = this._store.session;
        if (!session) return;

        const { default: parseExp } = await import("./AuthStateMachine").then(() =>
          ({ default: (j: string) => {
            try {
              const payload = JSON.parse(atob(j.split(".")[1])) as { exp?: number };
              return (payload.exp ?? 0) * 1000;
            } catch { return Date.now() + 55 * 60 * 1000; }
          }}));

        const expiresAt = parseExp(jwt);
        const updated = { ...session, jwt, expiresAt, lastRefreshedAt: Date.now() };
        this._store.setSession(updated);
        await this._secure.save({
          sessionId: updated.sessionId,
          userId: updated.userId,
          expiresAt: updated.expiresAt,
          lastRefreshedAt: updated.lastRefreshedAt,
          provider: updated.provider,
          monotonicOffsetMs: performance.now(),
        });
        this._retryAttempt = 0;
        this._journal.record("AUTH_REFRESH_SUCCEEDED",
          `JWT refreshed, expires in ${Math.round((expiresAt - Date.now()) / 60000)}min`);
        this.scheduleRefresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this._store.recordRefreshFailure();
        this._journal.record("AUTH_REFRESH_FAILED", msg);
        this._scheduleRetry();
      }
    }, "refresh");
  }

  private _scheduleRetry(): void {
    if (this._retryAttempt >= MAX_RETRY_ATTEMPTS) {
      this._journal.record("AUTH_DEGRADED",
        "Max refresh retries reached — session degraded");
      return;
    }
    const backoff = BASE_BACKOFF_MS * Math.pow(2, this._retryAttempt);
    this._retryAttempt++;
    this._timerId = setTimeout(() => this._doRefresh(), backoff);
  }

  private _cancelScheduled(): void {
    if (this._timerId !== null) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
  }
}
