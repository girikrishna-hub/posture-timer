/**
 * AuthRuntime — central orchestrator for the auth subsystem.
 *
 * Wires together all auth components into a single operational runtime.
 * This is the ONLY class that React (via AuthRuntimeContext) interacts with.
 *
 * Boot sequence:
 *   1. FSM → INITIALIZING
 *   2. Probe capabilities (Google Play Services, network, backend)
 *   3. Try to restore persisted session
 *   4. Clear RuntimeBootBarrier so React can render feature UI
 *   5. Attach lifecycle listeners
 *   6. Schedule token refresh if session is valid
 */

import { AuthStateMachine } from "./AuthStateMachine";
import type { StartupMode } from "./AuthStateMachine";
import { AuthStateStore } from "./AuthStateStore";
import type { RuntimeSession } from "./AuthStateStore";
import { AuthOperationQueue } from "./AuthOperationQueue";
import { SecureSessionStore } from "./SecureSessionStore";
import { GoogleAuthAdapter } from "./GoogleAuthAdapter";
import { ClerkBridgeAdapter } from "./ClerkBridgeAdapter";
import type { ClerkBindings } from "./ClerkBridgeAdapter";
import { AuthCapabilityRegistry } from "./AuthCapabilityRegistry";
import { AuthDiagnosticsJournal } from "./AuthDiagnosticsJournal";
import { RuntimeBootBarrier } from "./RuntimeBootBarrier";
import { AuthSessionManager } from "./AuthSessionManager";
import { AuthLifecycleCoordinator } from "./AuthLifecycleCoordinator";
import { AuthRecoveryCoordinator } from "./AuthRecoveryCoordinator";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { Capacitor } from "@capacitor/core";

export class AuthRuntime {
  readonly fsm = new AuthStateMachine();
  readonly store = new AuthStateStore();
  readonly queue = new AuthOperationQueue();
  readonly secure = new SecureSessionStore();
  readonly google = new GoogleAuthAdapter();
  readonly clerk = new ClerkBridgeAdapter();
  readonly capabilities = new AuthCapabilityRegistry();
  readonly journal = new AuthDiagnosticsJournal();
  readonly bootBarrier = new RuntimeBootBarrier(8000);

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
    this._sessionMgr = new AuthSessionManager(
      this.store, this.queue, this.clerk, this.secure, this.journal,
    );
    this._lifecycle = new AuthLifecycleCoordinator(
      this.fsm, this.store, this.queue, this._sessionMgr,
      this.capabilities, this.journal,
    );
    this._recovery = new AuthRecoveryCoordinator(
      this.fsm, this.store, this.queue, this._sessionMgr,
      this.secure, this.journal,
    );

    // Wire FSM transitions to journal and store
    this.fsm.subscribe((snap) => {
      this.journal.updateState(snap.state, snap.startupMode);
      this.journal.record("AUTH_STATE_TRANSITION",
        `${snap.previousState ?? "—"} → ${snap.state}`);
    });

    // Wire capability changes to journal and store
    this.capabilities.subscribe((cap) => {
      this.journal.updateCapability(cap.level);
      this.store.patch({ capability: cap.level });
    });

    // Wire store to journal diagnostics
    this.store.subscribe((s) => {
      this.journal.updateSession(
        s.session?.userId ?? null,
        s.session?.expiresAt ?? null,
        s.refreshFailures,
        s.session?.lastRefreshedAt ?? null,
        s.isRestored,
      );
      // Publish JWT getter to api-client-react
      setAuthTokenGetter(s.session ? () => Promise.resolve(s.session!.jwt) : null);
    });

    // Set API base URL for native builds
    if (Capacitor.isNativePlatform()) {
      const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
      if (apiBase) setBaseUrl(apiBase);
    }
  }

  /**
   * Boot the runtime. Must be called once on app startup before rendering
   * any feature UI. Safe to call multiple times (idempotent).
   */
  async boot(mode?: StartupMode): Promise<void> {
    if (this._booted) return;
    this._booted = true;

    const startupMode = mode ?? this._detectStartupMode();
    this.fsm.setStartupMode(startupMode);
    this.fsm.transition("INITIALIZING", "boot");

    this.journal.record("AUTH_INITIALIZED",
      `Boot started — mode: ${startupMode}`);

    try {
      // 1. Initialize native Google Sign-In plugin
      await this.google.initialize();

      // 2. Probe capabilities
      await this.capabilities.probe(this.google.isAvailable);

      // 3. Attempt session restoration
      this.fsm.transition("RESTORING_SESSION", "boot");
      await this._restoreSession();

      // 4. Attach lifecycle listeners
      this._lifecycle.attach();

      // 5. Clear boot barrier
      this.bootBarrier.clear("success");
      this.journal.record("AUTH_BOOT_BARRIER_CLEARED",
        `Boot complete — state: ${this.fsm.state}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.journal.record("AUTH_ERROR", `Boot failed: ${msg}`);
      this.bootBarrier.clear("error");
      this.fsm.tryTransition("SIGNED_OUT", "boot-error");
      this.store.patch({ isRestored: true });
    }
  }

  /**
   * Sign in with native Google account picker.
   * Returns the established session or throws a typed error.
   */
  async signInWithGoogle(): Promise<RuntimeSession> {
    return this.queue.enqueue(async () => {
      this.journal.record("AUTH_SIGN_IN_STARTED", "Native Google Sign-In initiated");
      this.fsm.tryTransition("SIGNING_IN", "google-sign-in");

      try {
        const identity = await this.google.signIn();
        this.journal.record("AUTH_SIGN_IN_STARTED",
          `Google identity acquired for ${identity.email}`);

        const session = await this.clerk.exchangeGoogleIdToken(
          identity.idToken,
          identity.providerId,
        );

        await this._establishSession(session);
        this.journal.record("AUTH_SIGN_IN_SUCCEEDED",
          `Signed in as ${identity.email}`);
        return session;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.journal.record("AUTH_SIGN_IN_FAILED", msg);
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
      this.journal.record("AUTH_SIGN_IN_STARTED", "Ticket exchange initiated");
      this.fsm.tryTransition("SIGNING_IN", "ticket-sign-in");

      try {
        const session = await this.clerk.exchangeTicket(ticket);
        await this._establishSession(session);
        this.journal.record("AUTH_SIGN_IN_SUCCEEDED", "Signed in via ticket");
        return session;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.journal.record("AUTH_SIGN_IN_FAILED", msg);
        this.fsm.tryTransition("SIGNED_OUT", "ticket-failed");
        throw e;
      }
    }, "sign-in-ticket");
  }

  /**
   * Called by ClerkRuntimeBridge once Clerk hooks are available.
   * The runtime is fully operational only after this is called.
   */
  bindClerk(bindings: ClerkBindings): void {
    this.clerk.bind(bindings);
    this.journal.record("AUTH_INITIALIZED", "Clerk bindings registered");
  }

  async signOut(): Promise<void> {
    return this.queue.enqueue(async () => {
      this._sessionMgr.cancelRefresh();
      await this.clerk.signOut();
      await this.google.signOut();
      await this.secure.clear();
      this.store.setSession(null);
      this.store.patch({ isRestored: true });
      this.fsm.tryTransition("SIGNED_OUT", "sign-out");
      this.journal.record("AUTH_SIGN_OUT_COMPLETED", "Signed out");
    }, "sign-out");
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  private async _restoreSession(): Promise<void> {
    const meta = await this.secure.load();

    if (!meta) {
      this.journal.record("AUTH_SESSION_RESTORED", "No persisted session found");
      this.fsm.tryTransition("SIGNED_OUT", "no-persisted-session");
      this.store.patch({ isRestored: true });
      return;
    }

    if (!this.secure.isRefreshable(meta)) {
      this.journal.record("AUTH_EXPIRED", "Persisted session too old to refresh");
      await this.secure.clear();
      this.fsm.tryTransition("SIGNED_OUT", "session-too-old");
      this.store.patch({ isRestored: true });
      return;
    }

    // Session exists — try to get a fresh JWT
    if (!navigator.onLine) {
      this.journal.record("AUTH_SESSION_RESTORED",
        "Offline startup — restoring degraded session from cache");
      // We can't get a real JWT offline, but we keep the session metadata
      // so the UI knows the user was authenticated
      this.store.patch({
        session: {
          sessionId: meta.sessionId,
          userId: meta.userId,
          jwt: "",  // empty JWT — API calls will fail gracefully
          expiresAt: meta.expiresAt,
          lastRefreshedAt: meta.lastRefreshedAt,
          provider: meta.provider,
        },
        capability: "OFFLINE_ONLY",
        isRestored: true,
      });
      this.fsm.tryTransition("OFFLINE_RECOVERY", "offline-startup");
      return;
    }

    // Online — attempt JWT refresh now
    try {
      // Wait for Clerk bindings to be ready (max 5s)
      await this._waitForClerk(5000);
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
      await this._establishSession(session);
      this.journal.record("AUTH_SESSION_RESTORED",
        `Session restored for user ${meta.userId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.journal.record("AUTH_REFRESH_FAILED",
        `Session restoration refresh failed: ${msg}`);
      // Clerk bindings may not be ready yet — keep session metadata,
      // let ClerkRuntimeBridge handle restoration once Clerk loads
      this.store.patch({
        session: {
          sessionId: meta.sessionId,
          userId: meta.userId,
          jwt: "",
          expiresAt: meta.expiresAt,
          lastRefreshedAt: meta.lastRefreshedAt,
          provider: meta.provider,
        },
        isRestored: true,
      });
      this.fsm.tryTransition("DEGRADED", "restore-refresh-failed");
    }
  }

  private async _establishSession(session: RuntimeSession): Promise<void> {
    this.store.setSession(session);
    this.store.patch({ isRestored: true });
    await this.secure.save({
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

  private _detectStartupMode(): StartupMode {
    // Very first load has no performance entries for navigation
    const entries = performance.getEntriesByType?.("navigation") ?? [];
    const nav = entries[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type === "reload") return "WARM_RESUME";
    if (nav?.type === "back_forward") return "PROCESS_RECOVERY";
    return "COLD_START";
  }

  private _parseJwtExp(jwt: string): number {
    try {
      const payload = JSON.parse(atob(jwt.split(".")[1])) as { exp?: number };
      return (payload.exp ?? 0) * 1000;
    } catch {
      return Date.now() + 55 * 60 * 1000;
    }
  }

  private _waitForClerk(timeoutMs: number): Promise<void> {
    if (this.clerk.isReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = setInterval(() => {
        if (this.clerk.isReady) { clearInterval(poll); resolve(); return; }
        if (Date.now() - start > timeoutMs) {
          clearInterval(poll);
          reject(new Error("Clerk bindings not ready within timeout"));
        }
      }, 100);
    });
  }
}
