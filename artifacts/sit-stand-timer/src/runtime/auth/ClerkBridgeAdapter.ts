/**
 * ClerkBridgeAdapter — isolates all Clerk SDK calls behind a stable interface.
 *
 * RuntimeCore never imports @clerk/react directly. All Clerk interactions
 * (token exchange, session hydration, token refresh, sign-out) go through
 * this adapter.
 *
 * HARDENED: The adapter now uses ClerkSessionTransport (window.Clerk global)
 * directly instead of React hook bindings. There is no bind()/unbind() lifecycle.
 * The adapter becomes operational as soon as window.Clerk.loaded is true,
 * which happens when InternalClerkProvider initializes — independently of
 * React component mounting order.
 */

import type { RuntimeSession } from "./AuthStateStore";
import { ClerkSessionTransport } from "./adapters/ClerkSessionTransport";
import { ClerkTokenExchange } from "./adapters/ClerkTokenExchange";
import { ClerkSessionHydrator } from "./adapters/ClerkSessionHydrator";

export class ClerkBridgeAdapter {
  readonly transport: ClerkSessionTransport;
  private readonly _exchange: ClerkTokenExchange;
  readonly hydrator: ClerkSessionHydrator;

  constructor(readyTimeoutMs = 10_000) {
    this.transport = new ClerkSessionTransport(readyTimeoutMs);
    this._exchange = new ClerkTokenExchange(this.transport);
    this.hydrator = new ClerkSessionHydrator(this.transport);
  }

  /**
   * True when window.Clerk is loaded. No React dependency.
   * This replaces the old bind()/isReady pattern.
   */
  get isReady(): boolean {
    return this.transport.isReady;
  }

  /**
   * Wait for window.Clerk to load. Safe to call any number of times.
   * Returns true on success, false on timeout.
   */
  async waitForReady(timeoutMs?: number): Promise<boolean> {
    return this.transport.waitForReady(timeoutMs);
  }

  /**
   * Exchange a native Google ID token for a Clerk session.
   */
  async exchangeGoogleIdToken(
    idToken: string,
    userId: string,
  ): Promise<RuntimeSession> {
    const { session } = await this._exchange.fromGoogleIdToken(idToken, userId);
    return session;
  }

  /**
   * Exchange a Clerk OAuth ticket (from deep-link callback) for a session.
   */
  async exchangeTicket(ticket: string): Promise<RuntimeSession> {
    const { session } = await this._exchange.fromTicket(ticket);
    return session;
  }

  /**
   * Get a fresh JWT from the current session. Returns null if no session.
   */
  async refreshToken(): Promise<string> {
    const jwt = await this.transport.getToken();
    if (!jwt) throw new Error("[ClerkBridge] refreshToken: getToken() returned null");
    return jwt;
  }

  /**
   * Sign out the current Clerk session. No-op if not signed in.
   */
  async signOut(): Promise<void> {
    await this.transport.signOut();
  }

  /**
   * Subscribe to Clerk session changes. Returns unsubscribe fn.
   */
  onSessionChange(
    fn: (meta: import("./adapters/ClerkSessionTransport").ClerkSessionMeta | null) => void,
  ): () => void {
    return this.transport.onSessionChange(fn);
  }
}
