/**
 * NativeGoogleSignInButton — triggers native Google account picker.
 *
 * Shows spinner during sign-in, error message on failure.
 * Falls back to web OAuth button when native Google auth is unavailable.
 */

import { useState } from "react";
import { useAuthRuntime, useAuthActions } from "./useAuthRuntime";

interface Props {
  /** Called when web OAuth fallback should be used */
  onWebFallback?: () => void;
  className?: string;
}

export function NativeGoogleSignInButton({ onWebFallback, className }: Props) {
  const { nativeGoogleAvailable, fsmState } = useAuthRuntime();
  const { signInWithGoogle } = useAuthActions();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSigningIn = fsmState === "SIGNING_IN" || loading;

  const handlePress = async () => {
    console.log(
      `[NativeAuth] Button.tap — nativeGoogleAvailable=${nativeGoogleAvailable} fsmState=${fsmState}`,
    );
    setError(null);

    if (!nativeGoogleAvailable) {
      console.warn("[NativeAuth] Button.tap — nativeGoogleAvailable=false → web fallback");
      onWebFallback?.();
      return;
    }

    setLoading(true);
    try {
      await signInWithGoogle();
    } catch (e) {
      const err = e as { code?: string; message?: string };
      console.error(
        `[NativeAuth] Button.tap ERROR — code=${err.code ?? "none"} msg=${err.message ?? String(e)}`,
      );
      if (err.code === "cancelled") {
        // User cancelled — no error shown
      } else if (err.code === "play_services_unavailable") {
        setError("Google Play Services unavailable");
        onWebFallback?.();
      } else {
        setError(err.message ?? "Sign-in failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const label = isSigningIn
    ? "Signing in…"
    : nativeGoogleAvailable
      ? "Continue with Google"
      : "Continue with Google (web)";

  return (
    <div className={className}>
      <button
        onClick={handlePress}
        disabled={isSigningIn}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          width: "100%",
          padding: "12px 20px",
          background: "#fff",
          border: "1px solid #dadce0",
          borderRadius: 8,
          fontSize: 15,
          fontWeight: 500,
          color: "#3c4043",
          cursor: isSigningIn ? "not-allowed" : "pointer",
          opacity: isSigningIn ? 0.7 : 1,
          fontFamily: "Inter, sans-serif",
        }}
      >
        {isSigningIn ? (
          <span style={{ width: 20, height: 20, borderRadius: "50%",
            border: "2px solid #dadce0", borderTopColor: "#4285f4",
            display: "inline-block", animation: "spin 0.8s linear infinite" }} />
        ) : (
          <GoogleIcon />
        )}
        {label}
      </button>

      {error && (
        <p style={{ color: "#d93025", fontSize: 13, marginTop: 8, textAlign: "center" }}>
          {error}
        </p>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}
