/**
 * ClerkBridgeAdapter — isolates all Clerk SDK calls behind a stable interface.
 *
 * RuntimeCore never imports @clerk/react directly. All Clerk interactions
 * (token exchange, session hydration, token refresh, sign-out) go through
 * this adapter.
 *
 * The adapter is wired to Clerk via two setter functions called from App.tsx
 * ONCE after ClerkProvider mounts:
 *   - bindSignIn(signIn, setActive) — the Clerk signIn object + setActive
 *   - bindGetToken(fn) — the live getToken function from useAuth
 *
 * This means the adapter can be instantiated before Clerk loads, and callers
 * queue naturally via AuthOperationQueue.
 */

import type { RuntimeSession } from "./AuthStateStore";

export type ClerkSignInFn = (params: Record<string, unknown>) => Promise<{
  status: string | null;
  createdSessionId?: string | null;
  identifier?: string;
  firstFactorVerification?: { externalVerificationRedirectURL?: { href?: string } | null };
}>;
export type ClerkSetActiveFn = (params: { session: string }) => Promise<void>;
export type ClerkGetTokenFn = () => Promise<string | null>;
export type ClerkSignOutFn = () => Promise<void>;

export interface ClerkBindings {
  signIn: ClerkSignInFn;
  setActive: ClerkSetActiveFn;
  getToken: ClerkGetTokenFn;
  signOut: ClerkSignOutFn;
}

export class ClerkBridgeAdapter {
  private _bindings: ClerkBindings | null = null;

  /** Called once from App.tsx after ClerkProvider + useSignIn/useAuth are ready */
  bind(bindings: ClerkBindings): void {
    this._bindings = bindings;
  }

  unbind(): void {
    this._bindings = null;
  }

  get isReady(): boolean {
    return this._bindings !== null;
  }

  /**
   * Exchange a Google ID token for a Clerk session.
   * Uses the OAuth ticket flow: creates a sign-in with strategy "oauth_token",
   * sets it active, then retrieves the JWT.
   */
  async exchangeGoogleIdToken(
    idToken: string,
    userId: string,
  ): Promise<RuntimeSession> {
    this._assertReady();
    const b = this._bindings!;

    const result = await b.signIn({
      strategy: "oauth_token",
      provider: "oauth_google",
      token: idToken,
    });

    if (result.status !== "complete" || !result.createdSessionId) {
      throw new Error(
        `[ClerkBridge] Google token exchange incomplete: status=${String(result.status)}`,
      );
    }

    await b.setActive({ session: result.createdSessionId });

    const jwt = await b.getToken();
    if (!jwt) throw new Error("[ClerkBridge] getToken() returned null after setActive");

    const expiresAt = this._parseJwtExp(jwt);
    return {
      sessionId: result.createdSessionId,
      userId,
      jwt,
      expiresAt,
      lastRefreshedAt: Date.now(),
      provider: "google_native",
    };
  }

  /**
   * Exchange a Clerk OAuth ticket (from deep-link callback) for a session.
   * Used as fallback when native Google auth is unavailable.
   */
  async exchangeTicket(ticket: string): Promise<RuntimeSession> {
    this._assertReady();
    const b = this._bindings!;

    const result = await b.signIn({ strategy: "ticket", ticket });
    if (result.status !== "complete" || !result.createdSessionId) {
      throw new Error(
        `[ClerkBridge] Ticket exchange incomplete: status=${String(result.status)}`,
      );
    }

    await b.setActive({ session: result.createdSessionId });

    const jwt = await b.getToken();
    if (!jwt) throw new Error("[ClerkBridge] getToken() returned null after ticket exchange");

    const expiresAt = this._parseJwtExp(jwt);
    return {
      sessionId: result.createdSessionId,
      userId: result.identifier ?? "unknown",
      jwt,
      expiresAt,
      lastRefreshedAt: Date.now(),
      provider: "google_web",
    };
  }

  /** Refresh the current session JWT */
  async refreshToken(): Promise<string> {
    this._assertReady();
    const jwt = await this._bindings!.getToken();
    if (!jwt) throw new Error("[ClerkBridge] refreshToken: getToken() returned null");
    return jwt;
  }

  async signOut(): Promise<void> {
    if (!this._bindings) return;
    await this._bindings.signOut();
  }

  private _assertReady(): void {
    if (!this._bindings) {
      throw new Error(
        "[ClerkBridge] Not ready — bind() has not been called yet. " +
        "Ensure ClerkProvider has mounted and ClerkRuntimeBridge has run.",
      );
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
