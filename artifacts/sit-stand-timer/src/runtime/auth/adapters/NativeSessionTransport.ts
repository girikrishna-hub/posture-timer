/**
 * NativeSessionTransport — backend-mediated session transport for native Android.
 *
 * Security model (hardened):
 *   Access tokens  — short-lived HS256 JWT (30 min), stateless
 *   Refresh tokens — opaque 32-byte hex, server-tracked, rotated on every use
 *
 * Local storage:
 *   Refresh token and session ID are stored in @capacitor/preferences under
 *   dedicated keys (separate from SecureSessionVault's auth metadata).
 *   On sign-out, both are cleared before the revoke network call so that
 *   a network failure does not leave credentials in local storage.
 *
 * Error signaling:
 *   HTTP 401 responses from /auth/native/refresh throw AuthProviderError
 *   with isNonRetriable=true. AuthSessionManager's classifyClerkError() picks
 *   this up and immediately transitions to SIGNED_OUT — no retry.
 *
 * No window.Clerk dependency. No frontend-origin validation.
 */

import { Preferences } from "@capacitor/preferences";
import { AuthProviderError } from "../AuthProviderError";

const REFRESH_TOKEN_KEY = "native_rt_v1";
const SESSION_ID_KEY    = "native_sid_v1";
const DEVICE_ID_KEY     = "native_device_id";

export interface NativeTransportResult {
  jwt:          string;   // access token (short-lived)
  refreshToken: string;   // opaque refresh token (stored locally, never in RuntimeSession)
  sessionId:    string;
  userId:       string;
  expiresAt:    number;   // ms since epoch (access token expiry)
}

export class NativeSessionTransport {
  private readonly _apiRoot: string;
  private readonly _getCurrentJwt: () => string | null;

  constructor(getCurrentJwt: () => string | null) {
    const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
    this._apiRoot    = base ? `${base}/api` : "/api";
    this._getCurrentJwt = getCurrentJwt;
  }

  get isReady(): boolean { return true; }
  async waitForReady(_timeoutMs?: number): Promise<boolean> { return true; }

  // ── Session establishment ──────────────────────────────────────────────────

  async exchangeGoogleIdToken(idToken: string): Promise<NativeTransportResult> {
    const deviceId = await this._getOrCreateDeviceId();
    const url = `${this._apiRoot}/auth/native/google`;
    console.log(`[NativeAuth] NativeTransport.exchange() START — url=${url} hasIdToken=${!!idToken}`);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          deviceId,
          platform:   "android",
          appVersion: (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "unknown",
        }),
      });
    } catch (networkErr) {
      console.error(`[NativeAuth] NativeTransport.exchange() NETWORK ERROR — ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`);
      throw networkErr;
    }

    console.log(`[NativeAuth] NativeTransport.exchange() response — status=${resp.status} ok=${resp.ok}`);

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: "exchange failed" })) as { error?: string };
      console.error(`[NativeAuth] NativeTransport.exchange() FAILED — status=${resp.status} error=${body.error ?? "unknown"}`);
      throw new Error(
        `[NativeTransport] google exchange ${resp.status}: ${body.error ?? "unknown"}`,
      );
    }

    const data = await resp.json() as {
      accessToken:  string;
      refreshToken: string;
      sessionId:    string;
      userId:       string;
      expiresAt:    number;
    };

    console.log(
      `[NativeAuth] NativeTransport.exchange() SUCCESS — userId=${data.userId} hasAccessToken=${!!data.accessToken} hasRefreshToken=${!!data.refreshToken}`,
    );

    // Persist refresh credentials immediately after successful exchange
    await Promise.all([
      Preferences.set({ key: REFRESH_TOKEN_KEY, value: data.refreshToken }),
      Preferences.set({ key: SESSION_ID_KEY,    value: data.sessionId }),
    ]);

    return {
      jwt:          data.accessToken,
      refreshToken: data.refreshToken,
      sessionId:    data.sessionId,
      userId:       data.userId,
      expiresAt:    data.expiresAt,
    };
  }

  // ── Token rotation ─────────────────────────────────────────────────────────

  /**
   * Refresh the access token using the stored opaque refresh token.
   *
   * On success: persists the new refresh token (old one is now permanently invalid).
   * On 401:     throws AuthProviderError(SESSION_INVALIDATED, isNonRetriable=true)
   *             → AuthSessionManager will skip retry and trigger sign-out.
   * On network error: returns null → AuthSessionManager will retry with backoff.
   */
  async refreshCurrentToken(): Promise<string | null> {
    const [rtResult, sidResult] = await Promise.all([
      Preferences.get({ key: REFRESH_TOKEN_KEY }),
      Preferences.get({ key: SESSION_ID_KEY }),
    ]);

    const refreshToken = rtResult.value;
    const sessionId    = sidResult.value;

    if (!refreshToken || !sessionId) return null;

    console.log(`[NativeAuth] NativeTransport.refresh() START — hasToken=${!!refreshToken} hasSid=${!!sessionId}`);

    let resp: Response;
    try {
      resp = await fetch(`${this._apiRoot}/auth/native/refresh`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ refreshToken, sessionId }),
      });
    } catch (networkErr) {
      console.warn(`[NativeAuth] NativeTransport.refresh() NETWORK ERROR — ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`);
      return null; // transient network error — eligible for retry
    }

    console.log(`[NativeAuth] NativeTransport.refresh() response — status=${resp.status}`);

    if (resp.status === 401) {
      const body = await resp.json().catch(() => ({})) as { error?: string };
      console.error(`[NativeAuth] NativeTransport.refresh() REVOKED — ${body.error ?? "unauthorized"} → throwing SESSION_INVALIDATED`);
      throw new AuthProviderError(
        "SESSION_INVALIDATED",
        `[NativeTransport] refresh rejected: ${body.error ?? "unauthorized"}`,
      );
    }

    if (!resp.ok) {
      console.warn(`[NativeAuth] NativeTransport.refresh() server error status=${resp.status} — retry eligible`);
      return null;
    }

    const data = await resp.json() as {
      accessToken?:  string;
      refreshToken?: string;
    };

    // Rotate stored refresh token — old one is now permanently invalid
    if (data.refreshToken) {
      await Preferences.set({ key: REFRESH_TOKEN_KEY, value: data.refreshToken });
    }

    return data.accessToken ?? null;
  }

  // ── Session revocation ────────────────────────────────────────────────────

  /**
   * Explicitly revoke the current session (called on sign-out).
   *
   * Clears local credentials BEFORE the network call so that a network
   * failure does not leave the refresh token accessible on-device.
   * Server revocation is best-effort (fire-and-forget on error).
   */
  async revokeCurrentSession(): Promise<void> {
    const [rtResult, sidResult] = await Promise.all([
      Preferences.get({ key: REFRESH_TOKEN_KEY }),
      Preferences.get({ key: SESSION_ID_KEY }),
    ]);

    const refreshToken = rtResult.value;
    const sessionId    = sidResult.value;

    // Clear local tokens first — security-critical order
    await Promise.allSettled([
      Preferences.remove({ key: REFRESH_TOKEN_KEY }),
      Preferences.remove({ key: SESSION_ID_KEY }),
    ]);

    if (refreshToken && sessionId) {
      // Best-effort server revocation — sign-out must succeed even offline
      fetch(`${this._apiRoot}/auth/native/revoke`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ refreshToken, sessionId }),
      }).catch(() => {});
    }
  }

  // ── Convenience passthrough (no-ops in native mode) ───────────────────────

  async signOut(): Promise<void> {
    await this.revokeCurrentSession();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _getOrCreateDeviceId(): Promise<string> {
    const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
    if (value) return value;
    // Generate a stable device identifier for this installation
    const id = crypto.randomUUID();
    await Preferences.set({ key: DEVICE_ID_KEY, value: id });
    return id;
  }
}
