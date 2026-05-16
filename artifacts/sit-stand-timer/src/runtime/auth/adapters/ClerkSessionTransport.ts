/**
 * ClerkSessionTransport — pure infrastructure layer for Clerk SDK communication.
 *
 * NO React dependency. NO hook dependency. NO UI dependency.
 *
 * Accesses Clerk's JavaScript SDK via the global window.Clerk object, which is
 * populated by InternalClerkProvider during React's first render.
 *
 * HARDENED: waitForReady() now delegates to ClerkRuntimeRegistry instead of
 * maintaining its own polling loop. There is exactly ONE polling source in the
 * entire codebase (ClerkRuntimeRegistry's 50ms interval watcher) — this transport
 * is a pure consumer of the registry's promise-based readiness API.
 */

import { ClerkRuntimeRegistry } from "../ClerkRuntimeRegistry";

// ── Minimal window.Clerk shape (avoids a full @clerk/types import) ────────────

interface ClerkSessionResource {
  id: string;
  userId: string;
  status: string;
  expireAt: Date | string;
  getToken: (opts?: { template?: string; leewayInSeconds?: number }) => Promise<string | null>;
}

interface ClerkSignInResult {
  status: string | null;
  createdSessionId: string | null;
  identifier: string | null;
}

interface ClerkSignInResource {
  create: (params: Record<string, unknown>) => Promise<ClerkSignInResult>;
}

interface ClerkClientResource {
  signIn: ClerkSignInResource;
  activeSessions: ClerkSessionResource[];
}

interface ClerkGlobal {
  loaded: boolean;
  session: ClerkSessionResource | null | undefined;
  client?: ClerkClientResource | null;
  setActive: (params: { session: string | null }) => Promise<void>;
  signOut: (opts?: { sessionId?: string }) => Promise<void>;
  addListener: (fn: (data: { session?: ClerkSessionResource | null }) => void) => () => void;
}

declare global {
  interface Window {
    Clerk?: ClerkGlobal;
  }
}

// ── Public shape exported to other adapters ───────────────────────────────────

export interface ClerkTransportResult {
  sessionId: string;
  userId: string;
  jwt: string;
  expiresAt: number;
}

export interface ClerkSessionMeta {
  sessionId: string;
  userId: string;
  expiresAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────

export class ClerkSessionTransport {
  private readonly _defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 10_000) {
    this._defaultTimeoutMs = defaultTimeoutMs;
  }

  /** True when window.Clerk is loaded and operational. */
  get isReady(): boolean {
    return !!(window.Clerk?.loaded);
  }

  /**
   * Wait for Clerk to become ready.
   * Delegates to ClerkRuntimeRegistry — no internal polling.
   * Returns true on success, false on timeout.
   */
  async waitForReady(timeoutMs?: number): Promise<boolean> {
    if (this.isReady) return true;
    return ClerkRuntimeRegistry.instance.waitForReady(timeoutMs ?? this._defaultTimeoutMs);
  }

  /**
   * Get a fresh JWT from the active Clerk session.
   * Does NOT require React to be mounted.
   */
  async getToken(): Promise<string | null> {
    this._assertReady();
    const session = window.Clerk!.session;
    if (!session) return null;
    return session.getToken({ leewayInSeconds: 10 });
  }

  /**
   * Exchange a native Google ID token for a Clerk session (oauth_token strategy).
   * This is the native-first sign-in path — no browser redirect required.
   */
  async exchangeGoogleIdToken(idToken: string): Promise<ClerkTransportResult> {
    this._assertReady();
    const clerk = window.Clerk!;
    const client = this._requireClient(clerk);

    const result = await client.signIn.create({
      strategy: "oauth_token",
      provider: "oauth_google",
      token: idToken,
    });

    if (result.status !== "complete" || !result.createdSessionId) {
      throw new Error(
        `[ClerkTransport] Google token exchange incomplete: status=${String(result.status)}`
      );
    }

    await clerk.setActive({ session: result.createdSessionId });
    return this._buildResult(result.createdSessionId);
  }

  /**
   * Exchange a Clerk OAuth ticket (from deep-link callback) for a session.
   * Used as fallback when native Google auth is unavailable.
   */
  async exchangeTicket(ticket: string): Promise<ClerkTransportResult> {
    this._assertReady();
    const clerk = window.Clerk!;
    const client = this._requireClient(clerk);

    const result = await client.signIn.create({
      strategy: "ticket",
      ticket,
    });

    if (result.status !== "complete" || !result.createdSessionId) {
      throw new Error(
        `[ClerkTransport] Ticket exchange incomplete: status=${String(result.status)}`
      );
    }

    await clerk.setActive({ session: result.createdSessionId });
    return this._buildResult(result.createdSessionId);
  }

  /**
   * Sign out the current Clerk session.
   * Safe to call when not signed in — no-op.
   */
  async signOut(): Promise<void> {
    const clerk = window.Clerk;
    if (!clerk) return;
    const sessionId = clerk.session?.id;
    await clerk.signOut(sessionId ? { sessionId } : undefined);
  }

  /**
   * Get lightweight metadata about the current Clerk session.
   * Returns null if no active session. Does NOT issue a network call.
   */
  getSessionMeta(): ClerkSessionMeta | null {
    const session = window.Clerk?.session;
    if (!session) return null;
    const expireAt = session.expireAt instanceof Date
      ? session.expireAt
      : new Date(session.expireAt);
    return {
      sessionId: session.id,
      userId: session.userId,
      expiresAt: expireAt.getTime(),
    };
  }

  /**
   * Subscribe to Clerk session changes.
   * Returns an unsubscribe function.
   * No-op if Clerk not loaded yet.
   */
  onSessionChange(
    fn: (session: ClerkSessionMeta | null) => void,
  ): () => void {
    const clerk = window.Clerk;
    if (!clerk?.addListener) return () => {};
    return clerk.addListener((data) => {
      const s = data.session;
      if (!s) { fn(null); return; }
      const expireAt = s.expireAt instanceof Date ? s.expireAt : new Date(s.expireAt);
      fn({ sessionId: s.id, userId: s.userId, expiresAt: expireAt.getTime() });
    });
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private async _buildResult(sessionId: string): Promise<ClerkTransportResult> {
    const clerk = window.Clerk!;
    const jwt = await clerk.session?.getToken({ leewayInSeconds: 10 });
    if (!jwt) throw new Error("[ClerkTransport] getToken() returned null after setActive");
    return {
      sessionId,
      userId: clerk.session?.userId ?? "unknown",
      jwt,
      expiresAt: this._parseJwtExp(jwt),
    };
  }

  private _assertReady(): void {
    if (!this.isReady) {
      throw new Error(
        "[ClerkTransport] Clerk SDK not ready — call waitForReady() first."
      );
    }
  }

  private _requireClient(clerk: ClerkGlobal): ClerkClientResource {
    if (!clerk.client) {
      throw new Error("[ClerkTransport] Clerk client resource not available");
    }
    return clerk.client;
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
