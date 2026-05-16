/**
 * ClerkSessionHydrator — hydrates a RuntimeSession from the live Clerk SDK state.
 *
 * Answers: "Does Clerk already have an active session we can bootstrap from?"
 *
 * On native (Capacitor), Clerk has no cookie persistence, so this typically
 * returns null on cold start. On web, it can recover a session from Clerk's
 * own storage. Either way, the result supplements — never replaces — the
 * SecureSessionVault restoration path.
 *
 * NO React dependency. Uses ClerkSessionTransport directly.
 */

import type { ClerkSessionTransport } from "./ClerkSessionTransport";
import type { RuntimeSession } from "../AuthStateStore";
import type { AuthConfidenceLevel } from "../AuthConfidenceLevel";

export interface HydratedSession {
  session: RuntimeSession;
  confidence: AuthConfidenceLevel;
}

export class ClerkSessionHydrator {
  constructor(private readonly _transport: ClerkSessionTransport) {}

  /**
   * Attempt to hydrate a session from the currently active Clerk session.
   * Returns null if Clerk has no active session or is not ready.
   */
  async hydrate(): Promise<HydratedSession | null> {
    if (!this._transport.isReady) return null;

    const meta = this._transport.getSessionMeta();
    if (!meta) return null;

    // Clerk has an active session — get a fresh JWT
    const jwt = await this._transport.getToken();
    if (!jwt) return null;

    const expiresAt = this._parseJwtExp(jwt);
    const now = Date.now();

    // Classify confidence based on token freshness
    const confidence: AuthConfidenceLevel =
      expiresAt > now + 5 * 60 * 1000 ? "RECOVERED" : "DEGRADED";

    return {
      session: {
        sessionId: meta.sessionId,
        userId: meta.userId,
        jwt,
        expiresAt,
        lastRefreshedAt: now,
        provider: "google_native", // hydrator doesn't know original provider
      },
      confidence,
    };
  }

  /**
   * Validate that the Clerk SDK session matches a persisted session ID.
   * Used to detect session desynchronization between Clerk and our vault.
   */
  validateContinuity(persistedSessionId: string): boolean {
    const meta = this._transport.getSessionMeta();
    if (!meta) return false;
    return meta.sessionId === persistedSessionId;
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
