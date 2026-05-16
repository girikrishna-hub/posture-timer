/**
 * AuthSessionManager — single refresh authority.
 *
 * Owns token refresh scheduling, expiry tracking, retry backoff, and
 * offline-aware refresh logic. No other component may call getToken()
 * for refresh purposes — they read from AuthStateStore.
 *
 * PHASE 5 ADDITIONS:
 * - Revoked account detection: non-retriable AuthProviderError skips retry
 *   and forces immediate chain failure + sign-out signal
 * - signalRevocation callback injected at construction for clean sign-out
 *   without circular dependency on AuthRuntime
 *
 * PHASE 3 ADDITIONS:
 * - RefreshChainCoordinator: every refresh belongs to a named chain
 * - onSuspend()/onResume(): lifecycle interruption recording
 * - stale chain expiry on resume
 */

import type { AuthStateStore } from "./AuthStateStore";
import type { AuthOperationQueue } from "./AuthOperationQueue";
import type { ClerkBridgeAdapter } from "./ClerkBridgeAdapter";
import type { AuthDiagnosticsJournal } from "./AuthDiagnosticsJournal";
import type { SecureSessionVault } from "./SecureSessionVault";
import type { TraceCorrelationManager } from "./TraceCorrelationManager";
import type { RefreshChainCoordinator } from "./RefreshChainCoordinator";
import { classifyClerkError, AuthProviderError } from "./AuthProviderError";

const REFRESH_BEFORE_EXPIRY_MS = 2 * 60 * 1000;
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
  private _currentChainId: string | null = null;
  private _destroyed = false;
  private _suspendedAt: number | null = null;

  constructor(
    private readonly _store: AuthStateStore,
    private readonly _queue: AuthOperationQueue,
    private readonly _clerk: ClerkBridgeAdapter,
    private readonly _vault: SecureSessionVault,
    private readonly _journal: AuthDiagnosticsJournal,
    private readonly _trace: TraceCorrelationManager,
    private readonly _chains: RefreshChainCoordinator,
    /** Called when a non-retriable provider error (revocation) is detected */
    private readonly _onRevocation?: (code: string) => void,
  ) {}

  scheduleRefresh(): void {
    this._cancelScheduled();
    const session = this._store.session;
    if (!session) return;

    const msUntilExpiry = session.expiresAt - Date.now();
    const delay = Math.max(0, msUntilExpiry - REFRESH_BEFORE_EXPIRY_MS);

    const ctx = this._trace.newOperation({ newRefreshChain: true });
    const chain = this._chains.beginChain(ctx.refreshChainId);
    this._currentChainId = ctx.refreshChainId;

    this._journal.record("AUTH_REFRESH_STARTED",
      `Refresh scheduled in ${Math.round(delay / 1000)}s ` +
      `(chain=${chain.chainId} op=${ctx.operationId})`);

    this._timerId = setTimeout(() => this._doRefresh(ctx.refreshChainId), delay);
  }

  cancelRefresh(): void {
    if (this._currentChainId) {
      this._chains.cancelChain(this._currentChainId, "CANCELLED");
      this._currentChainId = null;
    }
    this._cancelScheduled();
    this._retryAttempt = 0;
  }

  onSuspend(): void {
    this._suspendedAt = Date.now();
    if (this._currentChainId) {
      this._chains.recordSuspend(this._currentChainId);
    }
  }

  onResume(): void {
    if (this._suspendedAt !== null && this._currentChainId) {
      const suspendDurationMs = Date.now() - this._suspendedAt;
      this._chains.recordResume(this._currentChainId, suspendDurationMs);
    }
    this._suspendedAt = null;

    const expired = this._chains.expireStaleChains();
    if (expired.length > 0) {
      this._journal.record("AUTH_RECOVERY_STARTED",
        `Expired ${expired.length} stale refresh chain(s) on resume`);
      if (this._currentChainId && expired.includes(this._currentChainId)) {
        this._currentChainId = null;
      }
    }
  }

  destroy(): void {
    this._destroyed = true;
    this.cancelRefresh();
  }

  private async _doRefresh(chainId: string): Promise<void> {
    if (this._destroyed) return;
    if (!navigator.onLine) {
      this._journal.record("AUTH_REFRESH_FAILED",
        `chain=${chainId}: offline — will retry on reconnect`);
      this._chains.recordFailure(chainId, "OFFLINE");
      this._scheduleRetry(chainId);
      return;
    }

    await this._queue.enqueue(async () => {
      if (this._destroyed) return;
      const ctx = this._trace.newOperation();
      this._chains.recordAttempt(chainId);

      try {
        this._journal.record("AUTH_REFRESH_STARTED",
          `Refreshing JWT (chain=${chainId} op=${ctx.operationId})`);

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
        this._chains.completeChain(chainId);
        this._currentChainId = null;

        this._journal.record("AUTH_REFRESH_SUCCEEDED",
          `JWT refreshed, expires in ${Math.round((expiresAt - Date.now()) / 60000)}min ` +
          `(chain=${chainId} op=${ctx.operationId})`);

        this.scheduleRefresh();
      } catch (e) {
        // ── Revocation detection (Phase 5) ──────────────────────────────────
        const providerErr = classifyClerkError(e);
        if (providerErr?.isNonRetriable) {
          console.error(
            `[NativeAuth] AuthSessionManager — REVOCATION [${providerErr.code}] isNonRetriable=true → forcing sign-out`,
          );
          this._journal.record("AUTH_SIGN_OUT_COMPLETED",
            `Non-retriable provider error [${providerErr.code}] — forcing sign-out`);
          this._chains.failChain(chainId, providerErr.code);
          this._currentChainId = null;
          this._retryAttempt = 0;
          this._store.setSession(null, "INVALID");
          this._store.patch({ isRestored: true });
          this._onRevocation?.(providerErr.code);
          return; // no retry
        }

        const msg = e instanceof Error ? e.message : String(e);
        this._store.recordRefreshFailure();
        this._chains.recordFailure(chainId, msg);
        this._journal.record("AUTH_REFRESH_FAILED",
          `chain=${chainId} op=${ctx.operationId}: ${msg}`);
        this._scheduleRetry(chainId);
      }
    }, "refresh");
  }

  private _scheduleRetry(chainId: string): void {
    if (this._retryAttempt >= MAX_RETRY_ATTEMPTS) {
      this._chains.failChain(chainId, `max-retries-${MAX_RETRY_ATTEMPTS}`);
      this._currentChainId = null;
      this._journal.record("AUTH_DEGRADED",
        `Max refresh retries (${MAX_RETRY_ATTEMPTS}) reached on chain=${chainId} — staying degraded`);
      return;
    }
    const backoff = BASE_BACKOFF_MS * Math.pow(2, this._retryAttempt);
    this._retryAttempt++;
    this._journal.record("AUTH_REFRESH_STARTED",
      `Retry ${this._retryAttempt}/${MAX_RETRY_ATTEMPTS} in ${backoff}ms (chain=${chainId})`);
    this._timerId = setTimeout(() => this._doRefresh(chainId), backoff);
  }

  private _cancelScheduled(): void {
    if (this._timerId !== null) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
  }
}
