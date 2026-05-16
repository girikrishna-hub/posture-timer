/**
 * NativeSessionTransport — backend-mediated session transport for native Android.
 *
 * Replaces ClerkSessionTransport on Capacitor native builds.
 * No window.Clerk dependency. No frontend SDK initialization required.
 *
 * Exchange flow:
 *   1. Native GoogleAuth.signIn() → Google ID token (handled by GoogleAuthAdapter)
 *   2. POST /api/auth/native/google — backend verifies token with Google,
 *      finds/creates Clerk user via BAPI, issues a signed native JWT
 *   3. Subsequent refreshes: POST /api/auth/native/refresh with the stored JWT
 *
 * The backend is the sole authority for session issuance. No Clerk frontend-
 * origin validation participates in this path.
 */

export interface NativeTransportResult {
  jwt: string;
  sessionId: string;
  userId: string;
  expiresAt: number;
}

export class NativeSessionTransport {
  private readonly _apiRoot: string;
  private readonly _getCurrentJwt: () => string | null;

  constructor(getCurrentJwt: () => string | null) {
    const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
    this._apiRoot = base ? `${base}/api` : "/api";
    this._getCurrentJwt = getCurrentJwt;
  }

  get isReady(): boolean {
    return true;
  }

  async waitForReady(_timeoutMs?: number): Promise<boolean> {
    return true;
  }

  async exchangeGoogleIdToken(idToken: string): Promise<NativeTransportResult> {
    const resp = await fetch(`${this._apiRoot}/auth/native/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: "exchange failed" })) as { error?: string };
      throw new Error(
        `[NativeTransport] google exchange ${resp.status}: ${body.error ?? "unknown"}`,
      );
    }
    return resp.json() as Promise<NativeTransportResult>;
  }

  /**
   * Refresh the current native JWT.
   * Sends the current JWT as a Bearer token; backend verifies and issues a new one.
   * Returns the new JWT string, or null if the session cannot be refreshed.
   */
  async refreshCurrentToken(): Promise<string | null> {
    const currentJwt = this._getCurrentJwt();
    if (!currentJwt) return null;

    const resp = await fetch(`${this._apiRoot}/auth/native/refresh`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${currentJwt}` },
    });
    if (!resp.ok) return null;

    const data = await resp.json() as { token?: string };
    return data.token ?? null;
  }

  async signOut(): Promise<void> {
    // Native JWTs are stateless. Session termination is handled by
    // SecureSessionVault.clear() in AuthRuntime.signOut().
  }
}
