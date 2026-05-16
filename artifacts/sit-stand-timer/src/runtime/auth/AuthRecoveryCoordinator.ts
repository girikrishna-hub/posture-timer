/**
 * AuthRecoveryCoordinator — handles EXPIRED and DEGRADED states.
 *
 * Attempts to recover the session via token refresh. If that fails, persists
 * the offline state with an appropriate degradation level. Prevents recursive
 * recovery loops using a guard flag.
 */

import type { AuthStateMachine } from "./AuthStateMachine";
import type { AuthStateStore } from "./AuthStateStore";
import type { AuthOperationQueue } from "./AuthOperationQueue";
import type { AuthSessionManager } from "./AuthSessionManager";
import type { SecureSessionVault } from "./SecureSessionVault";
import type { AuthDiagnosticsJournal } from "./AuthDiagnosticsJournal";

const MAX_RECOVERY_ATTEMPTS = 3;

export class AuthRecoveryCoordinator {
  private _recoveryAttempts = 0;
  private _recovering = false;

  constructor(
    private readonly _fsm: AuthStateMachine,
    private readonly _store: AuthStateStore,
    private readonly _queue: AuthOperationQueue,
    private readonly _sessionMgr: AuthSessionManager,
    private readonly _vault: SecureSessionVault,
    private readonly _journal: AuthDiagnosticsJournal,
  ) {}

  /** Attempt recovery from EXPIRED state */
  async recoverExpired(): Promise<void> {
    if (this._recovering) {
      this._journal.record("AUTH_RECOVERY_STARTED",
        "Recovery already in progress — skipping duplicate");
      return;
    }
    if (this._recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      this._journal.record("AUTH_RECOVERY_COMPLETED",
        "Max recovery attempts reached — signing out");
      await this._forceSignOut("max-recovery-attempts");
      return;
    }

    await this._queue.enqueue(async () => {
      this._recovering = true;
      this._recoveryAttempts++;
      this._journal.record("AUTH_RECOVERY_STARTED",
        `Recovery attempt ${this._recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS}`);

      this._fsm.tryTransition("RECOVERING", "expired-recovery");

      try {
        this._sessionMgr.scheduleRefresh();
        this._journal.record("AUTH_RECOVERY_COMPLETED",
          "Recovery triggered — waiting for refresh");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this._journal.record("AUTH_RECOVERY_COMPLETED", `Recovery failed: ${msg}`);
        this._fsm.tryTransition("DEGRADED", "recovery-failed");
      } finally {
        this._recovering = false;
      }
    }, "recovery");
  }

  /** Handle DEGRADED state — attempt graceful downgrade vs forced sign-out */
  async handleDegraded(reason: string): Promise<void> {
    this._journal.record("AUTH_DEGRADED",
      `Degraded: ${reason} — checking offline viability`);

    const session = this._store.session;
    if (!session) {
      await this._forceSignOut("no-session-while-degraded");
      return;
    }

    if (!navigator.onLine && session.expiresAt > Date.now()) {
      this._store.patch({
        degradationReason: reason,
        capability: "OFFLINE_ONLY",
        confidence: "OFFLINE_ONLY",
      });
      this._journal.record("AUTH_DEGRADED",
        "Offline with valid session — degraded to OFFLINE_ONLY");
      return;
    }

    this._store.patch({
      degradationReason: reason,
      capability: "DEGRADED",
      confidence: "DEGRADED",
    });
  }

  resetAttempts(): void {
    this._recoveryAttempts = 0;
  }

  private async _forceSignOut(reason: string): Promise<void> {
    this._journal.record("AUTH_SIGN_OUT_COMPLETED", `Forced sign-out: ${reason}`);
    await this._vault.clear();
    this._store.setSession(null, "INVALID");
    this._store.patch({ isRestored: true });
    this._fsm.tryTransition("SIGNED_OUT", reason);
  }
}
