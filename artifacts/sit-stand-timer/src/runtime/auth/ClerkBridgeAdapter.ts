/**
 * ClerkBridgeAdapter — isolates all session-transport calls behind a stable interface.
 *
 * On web: delegates to ClerkSessionTransport (window.Clerk global).
 * On native Android (Capacitor): delegates to NativeSessionTransport — a backend-
 *   mediated path that issues native JWTs via our own API. No window.Clerk
 *   dependency, no frontend-origin validation, no Clerk SDK initialization required.
 *
 * The caller (AuthRuntime) is fully unaware of which transport is active.
 */

import { Capacitor } from "@capacitor/core";
import type { RuntimeSession } from "./AuthStateStore";
import { ClerkSessionTransport } from "./adapters/ClerkSessionTransport";
import { ClerkTokenExchange } from "./adapters/ClerkTokenExchange";
import { ClerkSessionHydrator } from "./adapters/ClerkSessionHydrator";
import { NativeSessionTransport } from "./adapters/NativeSessionTransport";

export class ClerkBridgeAdapter {
  readonly transport: ClerkSessionTransport;
  private readonly _exchange: ClerkTokenExchange;
  readonly hydrator: ClerkSessionHydrator;
  private readonly _native: NativeSessionTransport | null;

  /**
   * @param getCurrentJwt - Closure that returns the current JWT from AuthStateStore.
   *   Used by NativeSessionTransport.refreshCurrentToken() to authenticate the
   *   refresh request. On web this is never called (ClerkSessionTransport handles
   *   refresh via window.Clerk.session.getToken()).
   */
  constructor(
    getCurrentJwt: () => string | null = () => null,
    readyTimeoutMs = 10_000,
  ) {
    this.transport = new ClerkSessionTransport(readyTimeoutMs);
    this._exchange = new ClerkTokenExchange(this.transport);
    this.hydrator = new ClerkSessionHydrator(this.transport);
    this._native = Capacitor.isNativePlatform()
      ? new NativeSessionTransport(getCurrentJwt)
      : null;
  }

  /** True when the active transport is operational. Always true on native. */
  get isReady(): boolean {
    if (this._native) return true;
    return this.transport.isReady;
  }

  /**
   * Wait for the transport to become operational.
   * On native: resolves immediately (no SDK initialization needed).
   * On web: waits for window.Clerk.loaded via ClerkRuntimeRegistry.
   */
  async waitForReady(timeoutMs?: number): Promise<boolean> {
    if (this._native) return true;
    return this.transport.waitForReady(timeoutMs);
  }

  /**
   * Exchange a native Google ID token for a RuntimeSession.
   * On native: POST /api/auth/native/google (backend verifies + issues JWT).
   * On web: Clerk SDK oauth_token strategy.
   */
  async exchangeGoogleIdToken(
    idToken: string,
    userId: string,
  ): Promise<RuntimeSession> {
    if (this._native) {
      const result = await this._native.exchangeGoogleIdToken(idToken);
      return {
        sessionId: result.sessionId,
        userId: result.userId,
        jwt: result.jwt,
        expiresAt: result.expiresAt,
        lastRefreshedAt: Date.now(),
        provider: "google_native",
      };
    }
    const { session } = await this._exchange.fromGoogleIdToken(idToken, userId);
    return session;
  }

  /**
   * Exchange a Clerk OAuth ticket (deep-link callback) for a session.
   * Only applies to the web/redirect fallback path — not available in native mode.
   */
  async exchangeTicket(ticket: string): Promise<RuntimeSession> {
    if (this._native) {
      throw new Error(
        "[ClerkBridge] Ticket exchange is not supported in native mode",
      );
    }
    const { session } = await this._exchange.fromTicket(ticket);
    return session;
  }

  /**
   * Obtain a fresh JWT for the current session.
   * On native: POST /api/auth/native/refresh with the stored JWT.
   * On web: window.Clerk.session.getToken().
   */
  async refreshToken(): Promise<string> {
    if (this._native) {
      const jwt = await this._native.refreshCurrentToken();
      if (!jwt) throw new Error("[ClerkBridge] native refreshToken returned null");
      return jwt;
    }
    const jwt = await this.transport.getToken();
    if (!jwt) throw new Error("[ClerkBridge] refreshToken: getToken() returned null");
    return jwt;
  }

  /**
   * Sign out the current session.
   * On native: no-op — SecureSessionVault.clear() in AuthRuntime.signOut() is sufficient.
   * On web: Clerk SDK signOut().
   */
  async signOut(): Promise<void> {
    if (this._native) return;
    await this.transport.signOut();
  }

  /**
   * Subscribe to session changes.
   * On native: returns a no-op unsubscribe (no Clerk session events in native mode).
   * On web: Clerk SDK addListener().
   */
  onSessionChange(
    fn: (meta: import("./adapters/ClerkSessionTransport").ClerkSessionMeta | null) => void,
  ): () => void {
    if (this._native) return () => {};
    return this.transport.onSessionChange(fn);
  }
}
