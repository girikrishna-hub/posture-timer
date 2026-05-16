/**
 * NativeAuthScreen — sign-in UI for native builds.
 *
 * Shows native Google Sign-In button (account picker) as primary action.
 * Falls back to web OAuth flow via Clerk Browser if native is unavailable.
 * Email/password is a secondary option.
 */

import { useState } from "react";
import { useSignIn } from "@clerk/react/legacy";
import { Browser } from "@capacitor/browser";
import { useAuthRuntime, useAuthActions } from "./useAuthRuntime";
import { NativeGoogleSignInButton } from "./NativeGoogleSignInButton";
import { NATIVE_CLERK_PUBLISHABLE_KEY } from "@/lib/nativeConfig";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

export function NativeAuthScreen() {
  const { fsmState } = useAuthRuntime();
  const { signInWithGoogle } = useAuthActions();
  const { signIn: clerkSignIn, setActive } = useSignIn();

  const [tab, setTab] = useState<"google" | "email">("google");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);

  const isLoading = fsmState === "SIGNING_IN";

  // Web OAuth fallback: open Clerk's Google OAuth URL in Custom Tab.
  // The deep link handler in ClerkRuntimeBridge will pick up the ticket.
  const handleWebFallback = async () => {
    if (!clerkSignIn) return;
    try {
      const res = await clerkSignIn.create({
        strategy: "oauth_google",
        redirectUrl: `${API_BASE}/api/native-oauth-complete`,
        actionCompleteRedirectUrl: `${API_BASE}/api/native-oauth-complete`,
      });
      const oauthUrl = res.firstFactorVerification?.externalVerificationRedirectURL?.href;
      if (oauthUrl) {
        await Browser.open({ url: oauthUrl, presentationStyle: "popover" });
      }
    } catch (e) {
      console.error("[NativeAuthScreen] web OAuth fallback failed:", e);
    }
  };

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clerkSignIn || !setActive) return;
    setEmailError(null);
    setEmailLoading(true);
    try {
      const res = await clerkSignIn.create({ identifier: email, password });
      if (res.status === "complete" && res.createdSessionId) {
        await setActive({ session: res.createdSessionId });
        // ClerkRuntimeBridge will detect the new session and call bindClerk
      } else {
        setEmailError("Sign-in incomplete. Please try again.");
      }
    } catch (err) {
      const msg = (err as { errors?: Array<{ message: string }> })
        ?.errors?.[0]?.message ?? "Sign-in failed";
      setEmailError(msg);
    } finally {
      setEmailLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100dvh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      background: "hsl(60 9% 98%)",
      padding: "24px 20px",
      fontFamily: "Inter, sans-serif",
    }}>
      {/* Logo / branding */}
      <div style={{ marginBottom: 32, textAlign: "center" }}>
        <div style={{
          width: 64, height: 64, borderRadius: 16,
          background: "hsl(133 17% 59%)", margin: "0 auto 12px",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 32,
        }}>
          🧍
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "hsl(20 14% 4%)", margin: 0 }}>
          Posture Timer
        </h1>
        <p style={{ color: "hsl(25 5% 45%)", fontSize: 14, margin: "4px 0 0" }}>
          Sign in to sync your sessions
        </p>
      </div>

      {/* Card */}
      <div style={{
        width: "100%", maxWidth: 360,
        background: "#fff", borderRadius: 16,
        border: "1px solid hsl(60 5% 90%)",
        padding: "24px 20px",
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
      }}>
        {/* Tab switcher */}
        <div style={{
          display: "flex", borderRadius: 8,
          background: "hsl(60 5% 95%)", padding: 3, marginBottom: 20,
        }}>
          {(["google", "email"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1, padding: "7px 0", borderRadius: 6, border: "none",
                background: tab === t ? "#fff" : "transparent",
                color: tab === t ? "hsl(20 14% 4%)" : "hsl(25 5% 55%)",
                fontWeight: tab === t ? 600 : 400,
                fontSize: 13, cursor: "pointer",
                boxShadow: tab === t ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                fontFamily: "Inter, sans-serif",
              }}
            >
              {t === "google" ? "Google" : "Email"}
            </button>
          ))}
        </div>

        {tab === "google" ? (
          <div>
            <NativeGoogleSignInButton
              onWebFallback={handleWebFallback}
              className=""
            />
            {isLoading && (
              <p style={{ textAlign: "center", color: "hsl(25 5% 45%)",
                fontSize: 13, marginTop: 12 }}>
                Completing sign-in…
              </p>
            )}
          </div>
        ) : (
          <form onSubmit={handleEmailSignIn}>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={inputStyle}
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ ...inputStyle, marginTop: 10 }}
            />
            {emailError && (
              <p style={{ color: "#d93025", fontSize: 13, margin: "8px 0 0" }}>
                {emailError}
              </p>
            )}
            <button
              type="submit"
              disabled={emailLoading}
              style={{
                width: "100%", marginTop: 14, padding: "12px 0",
                background: "hsl(133 17% 59%)", color: "#fff",
                border: "none", borderRadius: 8, fontSize: 15,
                fontWeight: 600, cursor: emailLoading ? "not-allowed" : "pointer",
                opacity: emailLoading ? 0.7 : 1,
                fontFamily: "Inter, sans-serif",
              }}
            >
              {emailLoading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}
      </div>

      <p style={{ color: "hsl(25 5% 55%)", fontSize: 12, marginTop: 20 }}>
        v{__BUILD_COMMIT__} · {__BUILD_TIME__.slice(0, 10)}
      </p>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "11px 12px", borderRadius: 8,
  border: "1px solid hsl(60 5% 88%)", fontSize: 15,
  color: "hsl(20 14% 4%)", background: "#fff",
  fontFamily: "Inter, sans-serif", boxSizing: "border-box",
  outline: "none",
};

declare const __BUILD_TIME__: string;
declare const __BUILD_COMMIT__: string;
