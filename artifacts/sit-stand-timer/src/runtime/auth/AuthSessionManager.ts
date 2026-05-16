/**
 * AuthSessionManager — single refresh authority.
 *
 * Owns token refresh scheduling, expiry tracking, retry backoff, and
 * offline-aware refresh logic. No other component may call getToken()
 * for refresh purposes — they read from AuthStateStore.
 *
 * HARDENED:
 * - All refresh operations tagged with TraceCorrelationManager IDs
 * - Simplified JWT exp parsing (no dynamic import hack)
 * - Explicit refresh chain IDs for log correlation
 */

import type { AuthStateStore } from "./AuthStateStore";
import type { AuthOperationQueue } from "./AuthOperationQueue";
import type { ClerkBridgeAdapter } from "./ClerkBridgeAdapter";
import type { AuthDiagnosticsJournal } from "./AuthDiagnosticsJournal";
import type { SecureSessionVault } from "./SecureSessionVault";
import type { TraceCorrelationManager } from "./TraceCorrelationManager";

const REFRESH_BEFORE_EXPIRY_MS = 2 * 60 * 1000;  // refresh 2 min before expiry
const MAX_RETRY_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 5_000;

function parseJwtExp(jwt: string): number {
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1])) as { exp?: number };
    return (payload.exp ?? 0) * 1000;
  } catch {
    return Date.now() + 55 * 60 * 1000;
  }
}

export class AuthSessionManager {
  private _timerId: ReturnType<typeof setTimeout> | null = null;
  private _retryAttempt = 0;
  private _destroyed = false;

  constructor(
    private readonly _store: AuthStateStore,
    private readonly _queue: AuthOperationQueue,
    private readonly _clerk: ClerkBridgeAdapter,
    private readonly _vault: SecureSessionVault,
    private readonly _journal: AuthDiagnosticsJournal,
    private readonly _trace: TraceCorrelationManager,
  ) {}

  /** Start the refresh scheduler. Called after a session is established. */
  scheduleRefresh(): void {
    this._cancelScheduled();
    const session = this._store.session;
    if (!session) return;

    const msUntilExpiry = session.expiresAt - Date.now();
    const delay = Math.max(0, msUntilExpiry - REFRESH_BEFORE_EXPIRY_MS);

    const ctx = this._trace.newOperation({ newRefreshChain: true });
    this._journal.record("AUTH_REFRESH_STARTED",
      `Refresh scheduled in ${Math.round(delay / 1000)}s (chain=${ctx.refreshChainId})`,
      { expiresAt: session.expiresAt, delay });

    this._timerId = setTimeout(() => this._doRefresh(ctx.refreshChainId), delay);
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

  private async _doRefresh(refreshChainId: string): Promise<void> {
    if (this._destroyed) return;
    if (!navigator.onLine) {
      this._journal.record("AUTH_REFRESH_FAILED",
        `chain=${refreshChainId}: Device offline — will retry on reconnect`);
      this._scheduleRetry(refreshChainId);
      return;
    }

    await this._queue.enqueue(async () => {
      if (this._destroyed) return;
      const ctx = this._trace.newOperation();

      try {
        this._journal.record("AUTH_REFRESH_STARTED",
          `Refreshing JWT… (chain=${refreshChainId} op=${ctx.operationId})`);

        const jwt = await this._clerk.refreshToken();
        const session = this._store.session;
        if (!session) return;

        const expiresAt = parseJwtExp(jwt);
        const updated = { ...session, jwt, expiresAt, lastRefreshedAt: Date.now() };

        this._store.setSession(updated, "RECOVERED");
        await this._vault.save({
          sessionId: updated.sessionId,
          userId: updated.userId,
          expiresAt: updated.expiresAt,
          lastRefreshedAt: updated.lastRefreshedAt,
          provider: updated.provider,
          monotonicOffsetMs: performance.now(),
        });

        this._retryAttempt = 0;
        this._journal.record("AUTH_REFRESH_SUCCEEDED",
          `JWT refreshed, expires in ${Math.round((expiresAt - Date.now()) / 60000)}min ` +
          `(chain=${refreshChainId} op=${ctx.operationId})`);

        this.scheduleRefresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this._store.recordRefreshFailure();
        this._journal.record("AUTH_REFRESH_FAILED",
          `chain=${refreshChainId} op=${ctx.operationId}: ${msg}`);
        this._scheduleRetry(refreshChainId);
      }
    }, "refresh");
  }

  private _scheduleRetry(refreshChainId: string): void {
    if (this._retryAttempt >= MAX_RETRY_ATTEMPTS) {
      this._journal.record("AUTH_DEGRADED",
        `Max refresh retries (${MAX_RETRY_ATTEMPTS}) reached on chain=${refreshChainId}`);
      return;
    }
    const backoff = BASE_BACKOFF_MS * Math.pow(2, this._retryAttempt);
    this._retryAttempt++;
    this._journal.record("AUTH_REFRESH_STARTED",
      `Retry ${this._retryAttempt}/${MAX_RETRY_ATTEMPTS} in ${backoff}ms (chain=${refreshChainId})`);
    this._timerId = setTimeout(() => this._doRefresh(refreshChainId), backoff);
  }

  private _cancelScheduled(): void {
    if (this._timerId !== null) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
  }
}
