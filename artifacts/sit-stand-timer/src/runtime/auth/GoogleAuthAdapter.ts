/**
 * GoogleAuthAdapter — native Google Sign-In via @capacitor-firebase/authentication.
 *
 * Acquires a Google ID token from the platform account picker (Android / iOS).
 * The ID token is then exchanged with the backend via ClerkBridgeAdapter —
 * this adapter owns ONLY the identity acquisition step.
 *
 * Firebase Authentication is used solely as the native credential transport.
 * It does NOT own session state, refresh orchestration, or JWT lifecycle —
 * those remain entirely within RuntimeCore.
 *
 * Falls back gracefully on non-native platforms so the same interface works
 * in browser development without crashing.
 */

import { Capacitor } from "@capacitor/core";

export interface GoogleIdentity {
  idToken: string;
  email: string;
  displayName: string | null;
  photoUrl: string | null;
  /** Provider-level user ID (uid claim) */
  providerId: string;
}

export type GoogleAuthError =
  | { code: "cancelled"; message: string }
  | { code: "play_services_unavailable"; message: string }
  | { code: "network_error"; message: string }
  | { code: "unknown"; message: string; cause?: unknown };

type FirebasePlugin = {
  getCurrentUser: () => Promise<{ user: unknown | null }>;
  signInWithGoogle: (options?: unknown) => Promise<{
    credential: {
      providerId: string;
      idToken: string | null;
      accessToken: string | null;
    } | null;
    user: {
      uid: string;
      email: string | null;
      displayName: string | null;
      photoUrl: string | null;
    } | null;
  }>;
  signOut: () => Promise<void>;
};

export class GoogleAuthAdapter {
  private readonly _isNative = Capacitor.isNativePlatform();
  private _plugin: FirebasePlugin | null = null;

  /** Must be called during runtime boot before any sign-in attempt. */
  async initialize(): Promise<void> {
    console.log(
      `[NativeAuth] GoogleAuthAdapter.initialize() — isNative=${this._isNative}`,
    );
    if (!this._isNative) return;
    try {
      const mod = await import("@capacitor-firebase/authentication");
      const candidate = mod.FirebaseAuthentication as unknown as FirebasePlugin;
      // Probe the actual native bridge — getCurrentUser() will throw
      // "not implemented" if the plugin is not registered on this platform.
      // A null user response is fine; we just need the bridge to respond.
      await candidate.getCurrentUser();
      this._plugin = candidate;
      console.log(
        "[NativeAuth] GoogleAuthAdapter.initialize() SUCCESS — native bridge confirmed",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[NativeAuth] GoogleAuthAdapter.initialize() FAILED — native bridge unavailable: ${msg}`,
      );
      this._plugin = null;
    }
  }

  get isAvailable(): boolean {
    return this._isNative && this._plugin !== null;
  }

  /**
   * Open the native Google account picker and acquire a Google ID token.
   * Firebase Auth is used only for the native credential acquisition —
   * the resulting idToken is passed to RuntimeCore for Clerk exchange.
   * Throws a GoogleAuthError on any failure.
   */
  async signIn(): Promise<GoogleIdentity> {
    console.log(
      `[NativeAuth] GoogleAuthAdapter.signIn() START — isNative=${this._isNative} pluginLoaded=${!!this._plugin}`,
    );

    if (!this._isNative || !this._plugin) {
      console.error(
        "[NativeAuth] GoogleAuthAdapter.signIn() ABORT — not native or plugin null",
      );
      throw this._makeError(
        "play_services_unavailable",
        "Native Google Sign-In is only available on Android/iOS",
      );
    }

    try {
      console.log("[NativeAuth] GoogleAuthAdapter — launching account picker");
      const result = await this._plugin.signInWithGoogle();

      const idToken = result.credential?.idToken ?? null;
      const email = result.user?.email ?? "";

      console.log(
        `[NativeAuth] GoogleAuthAdapter — picker returned hasIdToken=${!!idToken} hasEmail=${!!email}`,
      );

      if (!idToken) {
        console.error(
          "[NativeAuth] GoogleAuthAdapter — Firebase sign-in returned no ID token",
        );
        throw this._makeError(
          "unknown",
          "Google Sign-In returned no ID token",
        );
      }

      console.log("[NativeAuth] GoogleAuthAdapter.signIn() SUCCESS");
      return {
        idToken,
        email,
        displayName: result.user?.displayName ?? null,
        photoUrl: result.user?.photoUrl ?? null,
        providerId: result.user?.uid ?? "",
      };
    } catch (e) {
      if (e && typeof e === "object" && "code" in e) {
        const coded = e as { code: string; message?: string };
        console.error(
          `[NativeAuth] GoogleAuthAdapter.signIn() ERROR (typed) — code=${coded.code} msg=${coded.message ?? ""}`,
        );
        const code = coded.code as string;
        if (
          code.includes("cancelled") ||
          code.includes("dismissed") ||
          code.includes("popup-closed") ||
          code.includes("12501")
        ) {
          throw this._makeError("cancelled", "User cancelled Google Sign-In");
        }
        if (code.includes("network") || code.includes("7:")) {
          throw this._makeError(
            "network_error",
            "Network error during Google Sign-In",
          );
        }
        throw this._makeError(
          "unknown",
          coded.message ?? "Google Sign-In failed",
          e,
        );
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[NativeAuth] GoogleAuthAdapter.signIn() ERROR (raw) — ${msg}`,
      );
      if (msg.includes("cancel") || msg.includes("12501")) {
        throw this._makeError("cancelled", "User cancelled Google Sign-In");
      }
      if (msg.includes("network") || msg.includes("7:")) {
        throw this._makeError(
          "network_error",
          "Network error during Google Sign-In",
        );
      }
      throw this._makeError("unknown", msg, e);
    }
  }

  async signOut(): Promise<void> {
    if (!this._isNative || !this._plugin) return;
    try {
      await this._plugin.signOut();
    } catch {
      /* sign-out errors are non-fatal */
    }
  }

  private _makeError(
    code: GoogleAuthError["code"],
    message: string,
    cause?: unknown,
  ): GoogleAuthError {
    return {
      code,
      message,
      ...(cause !== undefined ? { cause } : {}),
    } as GoogleAuthError;
  }
}
