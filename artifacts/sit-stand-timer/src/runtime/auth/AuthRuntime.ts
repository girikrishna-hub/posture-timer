/**
 * AuthRuntime — central orchestrator for the auth subsystem.
 *
 * Wires together all auth components into a single operational runtime.
 * This is the ONLY class that React (via useAuthRuntime) interacts with.
 *
 * HARDENED (Phase 3) — production-stable mobile authentication runtime:
 *
 * Boot sequence:
 *   1. FSM → INITIALIZING
 *   2. ProcessRecoveryCoordinator.assess() — classify startup, detect mid-write death
 *   3. Expire stale refresh chains from prior process
 *   4. Probe capabilities (Google Play Services, network, backend)
 *   5. Validate + restore persisted session via SessionRestorationValidator
 *   6. Wait for Clerk (ClerkRuntimeRegistry.waitForReady — event-driven, not polling)
 *   7. Attempt JWT refresh if session restorable
 *   8. Attach lifecycle listeners + BrowserRuntimeMonitor
 *   9. Wire BrowserRuntimeMonitor discontinuity handler
 *  10. Clear RuntimeBootBarrier with explicit terminal phase
 *
 * New public properties (Phase 3):
 *   refreshChains    — RefreshChainCoordinator (accessible from overlay + tests)
 *   processRecovery  — ProcessRecoveryCoordinator
 *   browserMonitor   — BrowserRuntimeMonitor
 *   time             — TimeAuthority singleton
 *   recoveryKind     — startup classification result (from processRecovery.assess())
 */

import { AuthStateMachine } from "./AuthStateMachine";
import type { StartupMode } from "./AuthStateMachine";
import { AuthStateStore } from "./AuthStateStore";
import type { RuntimeSession } from "./AuthStateStore";
import { AuthOperationQueue } from "./AuthOperationQueue";
import { SecureSessionVault } from "./SecureSessionVault";
import { ClerkBridgeAdapter } from "./ClerkBridgeAdapter";
import { GoogleAuthAdapter } from "./GoogleAuthAdapter";
import { AuthCapabilityRegistry } from "./AuthCapabilityRegistry";
import { AuthDiagnosticsJournal } from "./AuthDiagnosticsJournal";
import { RuntimeBootBarrier } from "./RuntimeBootBarrier";
import type { BootTerminalPhase } from "./RuntimeBootBarrier";
import { AuthSessionManager } from "./AuthSessionManager";
import { AuthLifecycleCoordinator } from "./AuthLifecycleCoordinator";
import { AuthRecoveryCoordinator } from "./AuthRecoveryCoordinator";
import { TraceCorrelationManager } from "./TraceCorrelationManager";
import { SessionRestorationValidator } from "./SessionRestorationValidator";
import { RefreshChainCoordinator } from "./RefreshChainCoordinator";
import { ProcessRecoveryCoordinator } from "./ProcessRecoveryCoordinator";
import type { StartupKind } from "./ProcessRecoveryCoordinator";
import { BrowserRuntimeMonitor } from "./BrowserRuntimeMonitor";
import { TimeAuthority } from "./TimeAuthority";
import type { AuthConfidenceLevel } from "./AuthConfidenceLevel";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { Capacitor } from "@capacitor/core";

export class AuthRuntime {
  // ── Core subsystems ─────────────────────────────────────────────────────────
  readonly fsm = new AuthStateMachine();
  readonly store = new AuthStateStore();
  readonly queue = new AuthOperationQueue();
  readonly vault = new SecureSessionVault();
  readonly google = new GoogleAuthAdapter();
  readonly clerk = new ClerkBridgeAdapter();
  readonly capabilities = new AuthCapabilityRegistry();
  readonly journal = new AuthDiagnosticsJournal();
  readonly bootBarrier = new RuntimeBootBarrier(8000);
  readonly trace = new TraceCorrelationManager();
  readonly validator = new SessionRestorationValidator();

  // ── Phase 3 additions ───────────────────────────────────────────────────────
  readonly refreshChains = new RefreshChainCoordinator();
  readonly processRecovery: ProcessRecoveryCoordinator;
  readonly browserMonitor: BrowserRuntimeMonitor;
  readonly time: TimeAuthority;

  /** Set after processRecovery.assess() completes during boot */
  recoveryKind: StartupKind | null = null;

  private _sessionMgr!: AuthSessionManager;
  private _lifecycle!: AuthLifecycleCoordinator;
  private _recovery!: AuthRecoveryCoordinator;
  private _booted = false;

  /** Singleton instance for the app lifetime */
  private static _instance: AuthRuntime | null = null;
  static get instance(): AuthRuntime {
    if (!AuthRuntime._instance) {
      AuthRuntime._instance = new AuthRuntime();
    }
    return AuthRuntime._instance;
  }

  private constructor() {
    this.processRecovery = new ProcessRecoveryCoordinator(
      this.vault, this.journal, this.trace,
    );
    this.browserMonitor = new BrowserRuntimeMonitor(this.journal);
    this.time = TimeAuthority.instance;

    this._sessionMgr = new AuthSessionManager(
      this.store, this.queue, this.clerk, this.vault,
      this.journal, this.trace, this.refreshChains,
    );
    this._lifecycle = new AuthLifecycleCoordinator(
      this.fsm, this.store, this.queue, this._sessionMgr,
      this.capabilities, this.journal, this.trace,
    );
    this._recovery = new AuthRecoveryCoordinator(
      this.fsm, this.store, this.queue, this._sessionMgr,
      this.vault, this.journal,
    );

    // Wire FSM transitions → journal + store
    this.fsm.subscribe((snap) => {
      this.journal.updateState(snap.state, snap.startupMode);
      this.journal.record("AUTH_STATE_TRANSITION",
        `${snap.previousState ?? "—"} → ${snap.state}` +
        ` [boot=${this.trace.bootSessionId}]`);
    });

    // Wire capability changes → journal + store
    this.capabilities.subscribe((cap) => {
      this.journal.updateCapability(cap.level);
      this.store.patch({ capability: cap.level });
    });

    // Wire store → JWT getter for api-client-react
    this.store.subscribe((s) => {
      this.journal.updateSession(
        s.session?.userId ?? null,
        s.session?.expiresAt ?? null,
        s.refreshFailures,
        s.session?.lastRefreshedAt ?? null,
        s.isRestored,
      );
      setAuthTokenGetter(s.session?.jwt ? () => Promise.resolve(s.session!.jwt) : null);
    });

    // Set API base URL for native builds
    if (Capacitor.isNativePlatform()) {
      const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
      if (apiBase) setBaseUrl(apiBase);
    }
  }

  /**
   * Boot the runtime. Called once at module level before React renders.
   * Safe to call multiple times (idempotent after first call).
   */
  async boot(mode?: StartupMode): Promise<void> {
    if (this._booted) return;
    this._booted = true;

    const bootCtx = this.trace.newOperation({ newRefreshChain: true });

    this.journal.record("AUTH_INITIALIZED",
      `Boot started — boot=${bootCtx.bootSessionId}`);

    let terminalPhase: BootTerminalPhase;

    try {
      // 1. Classify startup and detect process death recovery
      const assessment = await this.processRecovery.assess();
      this.recoveryKind = assessment.kind;

      // 2. Expire stale refresh chains from prior process
      const staleChains = this.refreshChains.expireStaleChains();
      if (staleChains.length > 0) {
        this.journal.record("AUTH_RECOVERY_STARTED",
          `Expired ${staleChains.length} stale refresh chain(s) from prior process`);
      }

      // 3. Set startup mode for FSM
      const startupMode = mode ?? this._kindToMode(assessment.kind);
      this.fsm.setStartupMode(startupMode);
      this.fsm.transition("INITIALIZING", "boot");

      // 4. Log time authority snapshot
      const timeSnap = this.time.snapshot;
      this.journal.record("AUTH_INITIALIZED",
        `TimeAuthority: drift=${Math.round(timeSnap.clockDriftMs)}ms ` +
        `trustworthy=${timeSnap.isTrustworthy} suspends=${timeSnap.suspendCount}`);

      // 5. Initialize native Google Sign-In plugin
      await this.google.initialize();

      // 6. Probe capabilities
      await this.capabilities.probe(this.google.isAvailable);

      // 7. Attempt session restoration (returns explicit terminal phase)
      this.fsm.transition("RESTORING_SESSION", "boot");
      terminalPhase = await this._restoreSession();

      // 8. Attach lifecycle listeners
      this._lifecycle.attach();

      // 9. Attach browser runtime monitor
      this.browserMonitor.attach();
      this.browserMonitor.onDiscontinuity((d) => {
        this.journal.record("AUTH_DEGRADED",
          `Browser runtime discontinuity: ${d.kind} — ${d.message}`);
        // If Clerk was recreated, mark transport capability as changed
        if (d.kind === "CLERK_RECREATED") {
          this.capabilities.update({ clerkTransportAvailable: false });
          // Re-check after brief delay to allow Clerk to re-initialize
          setTimeout(() => {
            const available = (window as { Clerk?: { loaded?: boolean } }).Clerk?.loaded ?? false;
            this.capabilities.update({ clerkTransportAvailable: available });
          }, 500);
        }
      });

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.journal.record("AUTH_ERROR",
        `Boot failed (boot=${bootCtx.bootSessionId}): ${msg}`);
      terminalPhase = "FAILED";
      this.fsm.tryTransition("SIGNED_OUT", "boot-error");
      this.store.patch({ isRestored: true });
    }

    // 10. Clear boot barrier with explicit outcome
    this.bootBarrier.clear(terminalPhase);
    this.journal.record("AUTH_BOOT_BARRIER_CLEARED",
      `Boot complete — state=${this.fsm.state} phase=${terminalPhase} ` +
      `kind=${this.recoveryKind ?? "unknown"} boot=${bootCtx.bootSessionId}`);
  }

  /**
   * Sign in with native Google account picker.
   */
  async signInWithGoogle(): Promise<RuntimeSession> {
    return this.queue.enqueue(async () => {
      const ctx = this.trace.newOperation({ newRefreshChain: true });
      this.journal.record("AUTH_SIGN_IN_STARTED",
        `Native Google Sign-In initiated (op=${ctx.operationId})`);
      this.fsm.tryTransition("SIGNING_IN", "google-sign-in");

      try {
        const identity = await this.google.signIn();
        this.journal.record("AUTH_SIGN_IN_STARTED",
          `Google identity acquired for ${identity.email} (op=${ctx.operationId})`);

        const session = await this.clerk.exchangeGoogleIdToken(
          identity.idToken,
          identity.providerId,
        );

        await this._establishSession(session, "VERIFIED");
        this.journal.record("AUTH_SIGN_IN_SUCCEEDED",
          `Signed in as ${identity.email} (op=${ctx.operationId})`);
        return session;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.journal.record("AUTH_SIGN_IN_FAILED",
          `op=${ctx.operationId}: ${msg}`);
        this.fsm.tryTransition("SIGNED_OUT", "sign-in-failed");
        throw e;
      }
    }, "sign-in-google");
  }

  /**
   * Sign in via Clerk OAuth ticket (deep-link callback fallback).
   */
  async signInWithTicket(ticket: string): Promise<RuntimeSession> {
    return this.queue.enqueue(async () => {
      const ctx = this.trace.newOperation({ newRefreshChain: true });
      this.journal.record("AUTH_SIGN_IN_STARTED",
        `Ticket exchange initiated (op=${ctx.operationId})`);
      this.fsm.tryTransition("SIGNING_IN", "ticket-sign-in");

      try {
        const session = await this.clerk.exchangeTicket(ticket);
        await this._establishSession(session, "VERIFIED");
        this.journal.record("AUTH_SIGN_IN_SUCCEEDED",
          `Signed in via ticket (op=${ctx.operationId})`);
        return session;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.journal.record("AUTH_SIGN_IN_FAILED",
          `op=${ctx.operationId}: ${msg}`);
        this.fsm.tryTransition("SIGNED_OUT", "ticket-failed");
        throw e;
      }
    }, "sign-in-ticket");
  }

  async signOut(): Promise<void> {
    return this.queue.enqueue(async () => {
      const ctx = this.trace.newOperation();
      this.journal.record("AUTH_SIGN_OUT_COMPLETED",
        `Sign-out initiated (op=${ctx.operationId})`);
      this._sessionMgr.cancelRefresh();
      await this.clerk.signOut();
      await this.google.signOut();
      await this.vault.clear();
      this.store.setSession(null, "INVALID");
      this.store.patch({ isRestored: true });
      this.fsm.tryTransition("SIGNED_OUT", "sign-out");
      this.journal.record("AUTH_SIGN_OUT_COMPLETED",
        `Signed out (op=${ctx.operationId})`);
    }, "sign-out");
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  private async _restoreSession(): Promise<BootTerminalPhase> {
    const meta = await this.vault.load();

    if (!meta) {
      this.journal.record("AUTH_SESSION_RESTORED", "No persisted session found — cold start");
      this.fsm.tryTransition("SIGNED_OUT", "no-persisted-session");
      this.store.patch({ isRestored: true });
      return "UNAUTHENTICATED";
    }

    const validation = this.validator.validate(meta);
    this.journal.record("AUTH_SESSION_RESTORED",
      `Validation: ${validation.outcome} | confidence=${validation.confidence} | ` +
      `drift=${Math.round(validation.clockDriftMs / 1000)}s | ` +
      `reason: ${validation.reason}`);

    switch (validation.outcome) {
      case "CORRUPTED":
      case "EXPIRED_UNRESTORABLE":
        await this.vault.clear();
        this.fsm.tryTransition("SIGNED_OUT",
          validation.outcome === "CORRUPTED" ? "session-corrupted" : "session-too-old");
        this.store.patch({ isRestored: true });
        return "UNAUTHENTICATED";

      case "OFFLINE_RESTORABLE":
        this.store.patch({
          session: {
            sessionId: meta.sessionId,
            userId: meta.userId,
            jwt: "",
            expiresAt: meta.expiresAt,
            lastRefreshedAt: meta.lastRefreshedAt,
            provider: meta.provider,
          },
          capability: "OFFLINE_ONLY",
          confidence: "OFFLINE_ONLY",
          isRestored: true,
        });
        this.fsm.tryTransition("OFFLINE_RECOVERY", "offline-startup");
        return "OFFLINE_RECOVERY";

      case "RESTORABLE":
      case "REFRESH_REQUIRED": {
        // Event-driven wait — no polling in this method
        const ready = await this.clerk.waitForReady(5_000);
        if (!ready) {
          this.journal.record("AUTH_DEGRADED",
            "Clerk SDK not ready within 5s — restoring in degraded mode");
          this.store.patch({
            session: {
              sessionId: meta.sessionId,
              userId: meta.userId,
              jwt: "",
              expiresAt: meta.expiresAt,
              lastRefreshedAt: meta.lastRefreshedAt,
              provider: meta.provider,
            },
            confidence: "DEGRADED",
            isRestored: true,
          });
          this.fsm.tryTransition("DEGRADED", "clerk-not-ready");
          return "DEGRADED";
        }

        const continuityOk = this.clerk.hydrator.validateContinuity(meta.sessionId);
        if (!continuityOk) {
          this.journal.record("AUTH_SESSION_RESTORED",
            "Clerk session ID mismatch — proceeding with refresh (expected on native)");
        }

        try {
          const jwt = await this.clerk.refreshToken();
          const expiresAt = this._parseJwtExp(jwt);
          const session: RuntimeSession = {
            sessionId: meta.sessionId,
            userId: meta.userId,
            jwt,
            expiresAt,
            lastRefreshedAt: Date.now(),
            provider: meta.provider,
          };
          await this._establishSession(session, validation.confidence as AuthConfidenceLevel);
          this.journal.record("AUTH_SESSION_RESTORED",
            `Session restored for user ${meta.userId}`);
          return "AUTHENTICATED";
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.journal.record("AUTH_REFRESH_FAILED",
            `Session restoration refresh failed: ${msg} — restoring degraded`);
          this.store.patch({
            session: {
              sessionId: meta.sessionId,
              userId: meta.userId,
              jwt: "",
              expiresAt: meta.expiresAt,
              lastRefreshedAt: meta.lastRefreshedAt,
              provider: meta.provider,
            },
            confidence: "DEGRADED",
            isRestored: true,
          });
          this.fsm.tryTransition("DEGRADED", "restore-refresh-failed");
          return "DEGRADED";
        }
      }
    }
  }

  private async _establishSession(
    session: RuntimeSession,
    confidence: AuthConfidenceLevel,
  ): Promise<void> {
    this.store.setSession(session, confidence);
    this.store.patch({ isRestored: true });
    await this.vault.save({
      sessionId: session.sessionId,
      userId: session.userId,
      expiresAt: session.expiresAt,
      lastRefreshedAt: session.lastRefreshedAt,
      provider: session.provider,
      monotonicOffsetMs: performance.now(),
    });
    this.fsm.tryTransition("SIGNED_IN", "session-established");
    this._sessionMgr.scheduleRefresh();
    this._recovery.resetAttempts();
  }

  private _kindToMode(kind: StartupKind): StartupMode {
    switch (kind) {
      case "WARM_RESUME":      return "WARM_RESUME";
      case "PROCESS_RECOVERY":
      case "BACKGROUND_RESTORE": return "PROCESS_RECOVERY";
      default:                 return "COLD_START";
    }
  }

  private _parseJwtExp(jwt: string): number {
    try {
      const payload = JSON.parse(atob(jwt.split(".")[1])) as { exp?: number };
      return (payload.exp ?? 0) * 1000;
    } catch {
      return Date.now() + 55 * 60 * 1000;
    }
  }
}
