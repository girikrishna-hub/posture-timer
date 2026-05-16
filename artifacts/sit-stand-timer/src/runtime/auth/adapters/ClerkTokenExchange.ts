/**
 * ClerkTokenExchange — normalizes all Clerk token exchange operations.
 *
 * Thin orchestration layer over ClerkSessionTransport that:
 * - maps transport results to RuntimeSession payloads
 * - classifies auth confidence from exchange outcomes
 * - normalizes error messages into structured AuthError shapes
 *
 * NO React dependency. NO Clerk hook dependency.
 */

import type { ClerkSessionTransport, ClerkTransportResult } from "./ClerkSessionTransport";
import type { RuntimeSession } from "../AuthStateStore";
import type { AuthConfidenceLevel } from "../AuthConfidenceLevel";

export interface ExchangeResult {
  session: RuntimeSession;
  confidence: AuthConfidenceLevel;
}

export class ClerkTokenExchange {
  constructor(private readonly _transport: ClerkSessionTransport) {}

  /**
   * Exchange a native Google ID token for a verified RuntimeSession.
   * Confidence is VERIFIED — we obtained a fresh JWT directly from Clerk.
   */
  async fromGoogleIdToken(
    idToken: string,
    providerId: string,
  ): Promise<ExchangeResult> {
    const result = await this._transport.exchangeGoogleIdToken(idToken);
    return {
      session: this._toSession(result, providerId, "google_native"),
      confidence: "VERIFIED",
    };
  }

  /**
   * Exchange a Clerk OAuth deep-link ticket for a session.
   * Confidence is VERIFIED — fresh exchange.
   */
  async fromTicket(ticket: string): Promise<ExchangeResult> {
    const result = await this._transport.exchangeTicket(ticket);
    return {
      session: this._toSession(result, result.userId, "google_web"),
      confidence: "VERIFIED",
    };
  }

  /**
   * Refresh the current session token.
   * Confidence is RECOVERED — existing session, fresh JWT.
   */
  async refresh(): Promise<{ jwt: string; expiresAt: number; confidence: AuthConfidenceLevel }> {
    const jwt = await this._transport.getToken();
    if (!jwt) {
      throw new Error("[ClerkTokenExchange] refresh: getToken() returned null");
    }
    const expiresAt = this._parseJwtExp(jwt);
    return { jwt, expiresAt, confidence: "RECOVERED" };
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private _toSession(
    result: ClerkTransportResult,
    userId: string,
    provider: RuntimeSession["provider"],
  ): RuntimeSession {
    return {
      sessionId: result.sessionId,
      userId: result.userId || userId,
      jwt: result.jwt,
      expiresAt: result.expiresAt,
      lastRefreshedAt: Date.now(),
      provider,
    };
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
