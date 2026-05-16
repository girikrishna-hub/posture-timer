/**
 * ClerkBridgeAdapter — isolates all session-transport calls behind a stable interface.
 *
 * On web: delegates to ClerkSessionTransport (window.Clerk global).
 * On native Android (Capacitor): delegates to NativeSessionTransport — a backend-
 *   mediated path that issues short-lived access tokens via our own API, with
 *   opaque server-tracked refresh tokens. No window.Clerk dependency.
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
   * @param getCurrentJwt - Returns the current access token from AuthStateStore.
   *   Used so NativeSessionTransport can authenticate API calls while the
   *   refresh token is stored separately in Preferences.
   */
  constructor(
    getCurrentJwt: () => string | null = () => null,
    readyTimeoutMs = 10_000,
  ) {
    this.transport = new ClerkSessionTransport(readyTimeoutMs);
    this._exchange = new ClerkTokenExchange(this.transport);
    this.hydrator  = new ClerkSessionHydrator(this.transport);
    this._native   = Capacitor.isNativePlatform()
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
   * Native: resolves immediately (no SDK init required).
   * Web: waits for window.Clerk.loaded via ClerkRuntimeRegistry.
   */
  async waitForReady(timeoutMs?: number): Promise<boolean> {
    if (this._native) return true;
    return this.transport.waitForReady(timeoutMs);
  }

  /**
   * Exchange a native Google ID token for a RuntimeSession.
   * Native: POST /api/auth/native/google → short-lived access token + opaque refresh token.
   * Web: Clerk SDK oauth_token strategy.
   */
  async exchangeGoogleIdToken(
    idToken: string,
    userId: string,
  ): Promise<RuntimeSession> {
    const transport = this._native ? "NATIVE" : "CLERK_WEB";
    console.log(`[NativeAuth] ClerkBridge.exchangeGoogleIdToken() — transport=${transport}`);

    if (this._native) {
      const result = await this._native.exchangeGoogleIdToken(idToken);
      console.log(
        `[NativeAuth] ClerkBridge exchange SUCCESS — userId=${result.userId} sessionId=${result.sessionId}`,
      );
      return {
        sessionId:       result.sessionId,
        userId:          result.userId,
        jwt:             result.jwt,
        expiresAt:       result.expiresAt,
        lastRefreshedAt: Date.now(),
        provider:        "google_native",
      };
    }

    console.log("[NativeAuth] ClerkBridge — falling through to Clerk web transport");
    const { session } = await this._exchange.fromGoogleIdToken(idToken, userId);
    return session;
  }

  /**
   * Exchange a Clerk OAuth ticket (deep-link callback) for a session.
   * Only applicable on web — not supported in native-first mode.
   */
  async exchangeTicket(ticket: string): Promise<RuntimeSession> {
    if (this._native) {
      throw new Error("[ClerkBridge] Ticket exchange is not supported in native mode");
    }
    const { session } = await this._exchange.fromTicket(ticket);
    return session;
  }

  /**
   * Obtain a fresh access token for the current session.
   * Native: POST /api/auth/native/refresh (rotates the refresh token).
   * Web: window.Clerk.session.getToken().
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
   * Native: revokes the server-side session and clears local refresh credentials.
   * Web: Clerk SDK signOut().
   */
  async signOut(): Promise<void> {
    if (this._native) {
      await this._native.revokeCurrentSession();
      return;
    }
    await this.transport.signOut();
  }

  /**
   * Subscribe to session changes.
   * Native: no-op unsubscribe (no Clerk session events in native mode).
   * Web: Clerk SDK addListener().
   */
  onSessionChange(
    fn: (meta: import("./adapters/ClerkSessionTransport").ClerkSessionMeta | null) => void,
  ): () => void {
    if (this._native) return () => {};
    return this.transport.onSessionChange(fn);
  }
}
