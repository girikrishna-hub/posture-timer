/**
 * GoogleAuthAdapter — native Google Sign-In via @codetrix-studio/capacitor-google-auth.
 *
 * Acquires a Google ID token from the platform account picker (Android Account
 * Manager / iOS GIDSignIn). The ID token is then exchanged with the backend
 * via ClerkBridgeAdapter — this adapter owns ONLY the identity acquisition step.
 *
 * Falls back to the web OAuth flow on non-native platforms so the same adapter
 * interface works in browser development without crashing.
 */

import { Capacitor } from "@capacitor/core";

export interface GoogleIdentity {
  idToken: string;
  email: string;
  displayName: string | null;
  photoUrl: string | null;
  /** Provider-level user ID (sub claim) */
  providerId: string;
}

export type GoogleAuthError =
  | { code: "cancelled"; message: string }
  | { code: "play_services_unavailable"; message: string }
  | { code: "network_error"; message: string }
  | { code: "unknown"; message: string; cause?: unknown };

export class GoogleAuthAdapter {
  private readonly _isNative = Capacitor.isNativePlatform();
  private _plugin: unknown = null;

  /** Must be called during runtime boot before any sign-in attempt. */
  async initialize(): Promise<void> {
    console.log(`[NativeAuth] GoogleAuthAdapter.initialize() — isNative=${this._isNative}`);
    if (!this._isNative) return;
    try {
      const mod = await import("@codetrix-studio/capacitor-google-auth");
      this._plugin = mod.GoogleAuth;
      // initialize() is synchronous in v3 of this plugin (returns void, not Promise)
      (mod.GoogleAuth as unknown as { initialize: () => void }).initialize();
      console.log("[NativeAuth] GoogleAuthAdapter.initialize() SUCCESS — plugin ready");
    } catch (e) {
      console.warn("[NativeAuth] GoogleAuthAdapter.initialize() FAILED — plugin not available:", e);
      this._plugin = null;
    }
  }

  get isAvailable(): boolean {
    return this._isNative && this._plugin !== null;
  }

  /**
   * Open the native account picker and acquire a Google ID token.
   * Throws a GoogleAuthError on any failure.
   */
  async signIn(): Promise<GoogleIdentity> {
    console.log(
      `[NativeAuth] GoogleAuthAdapter.signIn() START — isNative=${this._isNative} pluginLoaded=${!!this._plugin}`,
    );

    if (!this._isNative || !this._plugin) {
      console.error("[NativeAuth] GoogleAuthAdapter.signIn() ABORT — not native or plugin null");
      throw this._makeError("play_services_unavailable",
        "Native Google Sign-In is only available on Android/iOS");
    }

    try {
      const plugin = this._plugin as {
        signIn: () => Promise<{
          idToken?: string;
          authentication?: { idToken?: string };
          email: string;
          name?: string;
          givenName?: string;
          imageUrl?: string;
          id: string;
        }>;
      };
      console.log("[NativeAuth] GoogleAuthAdapter — launching account picker");
      const result = await plugin.signIn();
      const idToken = result.idToken ?? result.authentication?.idToken;
      console.log(
        `[NativeAuth] GoogleAuthAdapter — picker returned hasIdToken=${!!idToken} hasEmail=${!!result.email}`,
      );
      if (!idToken) {
        console.error("[NativeAuth] GoogleAuthAdapter — picker returned NO id token");
        throw this._makeError("unknown", "Google Sign-In returned no ID token");
      }
      console.log("[NativeAuth] GoogleAuthAdapter.signIn() SUCCESS");
      return {
        idToken,
        email: result.email,
        displayName: result.name ?? result.givenName ?? null,
        photoUrl: result.imageUrl ?? null,
        providerId: result.id,
      };
    } catch (e) {
      if (e && typeof e === "object" && "code" in e) {
        const coded = e as { code: string; message?: string };
        console.error(
          `[NativeAuth] GoogleAuthAdapter.signIn() ERROR (typed) — code=${coded.code} msg=${coded.message ?? ""}`,
        );
        throw e as GoogleAuthError;
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[NativeAuth] GoogleAuthAdapter.signIn() ERROR (raw) — ${msg}`);
      if (msg.includes("cancel") || msg.includes("12501")) {
        throw this._makeError("cancelled", "User cancelled Google Sign-In");
      }
      if (msg.includes("network") || msg.includes("7:")) {
        throw this._makeError("network_error", "Network error during Google Sign-In");
      }
      if (msg.includes("play") || msg.includes("10:")) {
        throw this._makeError("play_services_unavailable",
          "Google Play Services not available");
      }
      throw this._makeError("unknown", msg, e);
    }
  }

  async signOut(): Promise<void> {
    if (!this._isNative || !this._plugin) return;
    try {
      await (this._plugin as { signOut: () => Promise<void> }).signOut();
    } catch {
      /* sign-out errors are non-fatal */
    }
  }

  private _makeError(
    code: GoogleAuthError["code"],
    message: string,
    cause?: unknown,
  ): GoogleAuthError {
    return { code, message, ...(cause !== undefined ? { cause } : {}) } as GoogleAuthError;
  }
}
