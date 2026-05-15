import { useState, useEffect, useRef } from "react";
import { useSignIn } from "@clerk/react/legacy";
import { Browser } from "@capacitor/browser";
import { App } from "@capacitor/app";
import { authLog } from "@/lib/authLog";

/**
 * Native (Capacitor) sign-in screen.
 *
 * Email + password: calls signIn.create() + setActive() — no navigation needed.
 *
 * Google OAuth flow:
 *  1. signIn.create({ strategy:'oauth_google', redirectUrl, actionCompleteRedirectUrl })
 *  2. Open externalVerificationRedirectURL in Chrome Custom Tab (@capacitor/browser)
 *  3. Google auth → Clerk SSO callback → Clerk 302s to actionCompleteRedirectUrl
 *  4. Our /api/native-oauth-complete endpoint 302s to posture-timer://oauth-callback?__clerk_ticket=…
 *  5. Android intent filter fires appUrlOpen in the Capacitor WebView
 *  6. We extract __clerk_ticket → signIn.create({ strategy:'ticket', ticket })
 *  7. setActive() → isSignedIn=true → app renders
 *  8. Browser.close() after setActive (Variant B — browser stays open during exchange)
 */

const SSO_CALLBACK_URL =
  "https://posture-timer.replit.app/sign-in/sso-callback";

const OAUTH_COMPLETE_URL =
  "https://posture-timer.replit.app/api/native-oauth-complete";

// Module-level mount counter so we can detect activity recreation.
let _mountCount = 0;

export function NativeSignIn() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [view, setView] = useState<"signIn" | "forgotPassword" | "resetSent">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mountId = useRef(0);

  // ── mount / unmount logging (detects app recreation after OAuth) ───────────
  useEffect(() => {
    _mountCount += 1;
    mountId.current = _mountCount;
    authLog(
      `NativeSignIn mounted (instance #${mountId.current}, isLoaded=${isLoaded}, signIn=${!!signIn})`,
      "info",
    );
    return () => {
      authLog(`NativeSignIn unmounted (instance #${mountId.current})`, "warn");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── log Clerk hook state changes ───────────────────────────────────────────
  useEffect(() => {
    authLog(
      `Clerk hook state → isLoaded=${isLoaded}  signIn=${!!signIn}  setActive=${!!setActive}`,
      isLoaded ? "ok" : "info",
    );
  }, [isLoaded, signIn, setActive]);

  // ── appUrlOpen listener (OAuth deep-link callback) ─────────────────────────
  useEffect(() => {
    authLog(
      `Registering appUrlOpen listener (isLoaded=${isLoaded}, signIn=${!!signIn})`,
      "info",
    );

    if (!isLoaded || !signIn || !setActive) {
      authLog("appUrlOpen listener NOT registered — Clerk not ready yet", "warn");
      return;
    }

    authLog("appUrlOpen listener REGISTERED ✓", "ok");

    const listenerPromise = App.addListener("appUrlOpen", async ({ url }) => {
      const t0 = Date.now();
      authLog(`appUrlOpen fired  url="${url}"`, "info");

      if (!url.startsWith("posture-timer://")) {
        authLog(`appUrlOpen: ignoring non-posture-timer URL`, "warn");
        return;
      }

      authLog(`appUrlOpen: posture-timer:// scheme matched ✓`, "ok");
      authLog(`Clerk state at callback → isLoaded=${isLoaded}  signIn=${!!signIn}`, "info");

      setLoading(true);
      setError("");

      try {
        // ── parse ticket ────────────────────────────────────────────────────
        // url format: posture-timer://oauth-callback?__clerk_ticket=XYZ
        const parsed = new URL(url.replace(/^posture-timer:\/\//, "https://x/"));
        const ticket = parsed.searchParams.get("__clerk_ticket");
        authLog(`Parsed URL path="${parsed.pathname}" searchParams="${parsed.search}"`, "info");
        authLog(ticket ? `Ticket extracted: ${ticket.slice(0, 16)}…` : "NO ticket in URL — missing __clerk_ticket", ticket ? "ok" : "error");

        if (!ticket) {
          setError("OAuth callback missing ticket. Please try again.");
          setLoading(false);
          return;
        }

        // ── Variant B: Browser.close AFTER setActive ────────────────────────
        // We keep the Custom Tab open during the ticket exchange so Android
        // doesn't consider the app lifecycle "resumed" mid-flight.

        // ── ticket exchange ─────────────────────────────────────────────────
        authLog(`Calling signIn.create({ strategy:'ticket' }) …`, "info");
        let result: { status: string; createdSessionId?: string };
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result = await (signIn.create as (p: any) => Promise<any>)({
            strategy: "ticket",
            ticket,
          });
          authLog(
            `signIn.create ticket → status="${result.status}"  sessionId="${result.createdSessionId ?? "none"}"`,
            result.status === "complete" ? "ok" : "warn",
          );
        } catch (exchErr: unknown) {
          const clerkErr = exchErr as { errors?: { message: string; code: string }[] };
          const msg = clerkErr.errors?.[0]?.message ?? (exchErr instanceof Error ? exchErr.message : String(exchErr));
          const code = clerkErr.errors?.[0]?.code ?? "unknown";
          authLog(`signIn.create ticket FAILED  code="${code}"  msg="${msg}"`, "error");
          setError(msg);
          setLoading(false);
          return;
        }

        if (result.status !== "complete") {
          authLog(`Ticket exchange incomplete — status="${result.status}"`, "error");
          setError("OAuth sign-in incomplete. Please try again.");
          setLoading(false);
          return;
        }

        // ── setActive ───────────────────────────────────────────────────────
        authLog(`Calling setActive({ session:"${result.createdSessionId}" }) …`, "info");
        await setActive({ session: result.createdSessionId });
        const elapsed = Date.now() - t0;
        authLog(`setActive() resolved — auth complete in ${elapsed}ms ✓`, "ok");

        // ── close browser AFTER successful setActive (Variant B) ────────────
        authLog("Closing Custom Tab (Variant B — after setActive) …", "info");
        await Browser.close();
        authLog("Browser.close() resolved ✓", "ok");

        // isSignedIn → true → NativeAppShell re-renders to show the app.

      } catch (err: unknown) {
        const clerkErr = err as { errors?: { message: string }[] };
        const msg = clerkErr.errors?.[0]?.message ?? (err instanceof Error ? err.message : String(err));
        authLog(`appUrlOpen outer catch: ${msg}`, "error");
        setError(msg);
        // Try to close browser even on unexpected errors
        Browser.close().catch(() => {});
      } finally {
        setLoading(false);
      }
    });

    return () => {
      authLog("appUrlOpen listener removed (effect cleanup)", "warn");
      listenerPromise.then((l) => l.remove()).catch(() => {});
    };
  }, [isLoaded, signIn, setActive]);

  // ── email / password sign-in ───────────────────────────────────────────────
  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (!signIn || !setActive) return;
    setLoading(true);
    setError("");
    try {
      const result = await signIn.create({ identifier: email, password });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
      } else {
        setError("Sign-in incomplete — additional verification may be required.");
      }
    } catch (err: unknown) {
      const clerkErr = err as { errors?: { message: string }[] };
      setError(clerkErr.errors?.[0]?.message ?? "Sign in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // ── Google OAuth sign-in ───────────────────────────────────────────────────
  async function handleGoogleSignIn() {
    if (!signIn) {
      authLog("handleGoogleSignIn: signIn is null — Clerk not ready", "error");
      return;
    }
    authLog("handleGoogleSignIn: starting …", "info");
    setLoading(true);
    setError("");
    try {
      authLog(`signIn.create({ strategy:'oauth_google', redirectUrl:'${SSO_CALLBACK_URL}', actionCompleteRedirectUrl:'${OAUTH_COMPLETE_URL}' })`, "info");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (signIn.create as (p: any) => Promise<any>)({
        strategy: "oauth_google",
        redirectUrl: SSO_CALLBACK_URL,
        actionCompleteRedirectUrl: OAUTH_COMPLETE_URL,
      });

      const redirectUrl: string | undefined =
        result?.firstFactorVerification?.externalVerificationRedirectURL?.href ??
        result?.firstFactorVerification?.externalVerificationRedirectURL;

      authLog(`signIn.create OAuth → status="${result?.status}"  redirectUrl=${redirectUrl ? redirectUrl.slice(0, 60) + "…" : "MISSING"}`, redirectUrl ? "ok" : "error");

      if (!redirectUrl) {
        setError("Could not start Google sign-in. Please try again.");
        setLoading(false);
        return;
      }

      authLog("Browser.open() — opening Custom Tab …", "info");
      await Browser.open({ url: redirectUrl });
      authLog("Browser.open() resolved — Custom Tab launched ✓", "ok");
      // setLoading stays true until appUrlOpen handler resolves.
    } catch (err: unknown) {
      const clerkErr = err as { errors?: { message: string }[] };
      const msg = clerkErr.errors?.[0]?.message ?? (err instanceof Error ? err.message : String(err));
      authLog(`handleGoogleSignIn error: ${msg}`, "error");
      setError(msg);
      setLoading(false);
    }
  }

  // ── forgot password ────────────────────────────────────────────────────────
  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!signIn) return;
    setLoading(true);
    setError("");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (signIn.create as (p: any) => Promise<unknown>)({
        strategy: "reset_password_email_code",
        identifier: email,
      });
      setView("resetSent");
    } catch (err: unknown) {
      const clerkErr = err as { errors?: { message: string }[] };
      setError(clerkErr.errors?.[0]?.message ?? "Could not send reset email.");
    } finally {
      setLoading(false);
    }
  }

  if (!isLoaded) {
    return <div className="min-h-screen bg-background" />;
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8 gap-3">
          <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center shadow-sm">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold text-foreground">Sit + Stand</h1>
            <p className="text-sm text-muted-foreground">Your daily movement tracker</p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
          {view === "signIn" && (
            <>
              <h2 className="text-lg font-semibold text-foreground mb-4">Sign in</h2>

              {/* Google OAuth */}
              <button
                type="button"
                disabled={loading}
                onClick={handleGoogleSignIn}
                className="w-full flex items-center justify-center gap-2.5 rounded-xl border border-input bg-background py-2.5 text-sm font-medium text-foreground disabled:opacity-50 active:opacity-80 mb-4"
              >
                <GoogleIcon />
                Continue with Google
              </button>

              {/* Divider */}
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">or</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              <form onSubmit={handleSignIn} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground" htmlFor="native-email">
                    Email address
                  </label>
                  <input
                    id="native-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    placeholder="you@example.com"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-foreground" htmlFor="native-password">
                      Password
                    </label>
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => { setView("forgotPassword"); setError(""); }}
                    >
                      Forgot password?
                    </button>
                  </div>
                  <input
                    id="native-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    placeholder="••••••••"
                  />
                </div>

                {error && (
                  <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading || !email || !password}
                  className="w-full rounded-xl bg-primary py-2.5 text-sm font-semibold text-white disabled:opacity-50 active:opacity-80"
                >
                  {loading ? "Signing in…" : "Sign in"}
                </button>
              </form>
            </>
          )}

          {view === "forgotPassword" && (
            <>
              <h2 className="text-lg font-semibold text-foreground mb-1">Reset password</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Enter your email and we'll send a reset link.
              </p>
              <form onSubmit={handleForgotPassword} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground" htmlFor="reset-email">
                    Email address
                  </label>
                  <input
                    id="reset-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    placeholder="you@example.com"
                  />
                </div>

                {error && (
                  <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading || !email}
                  className="w-full rounded-xl bg-primary py-2.5 text-sm font-semibold text-white disabled:opacity-50 active:opacity-80"
                >
                  {loading ? "Sending…" : "Send reset email"}
                </button>

                <button
                  type="button"
                  className="text-sm text-muted-foreground hover:text-foreground text-center"
                  onClick={() => { setView("signIn"); setError(""); }}
                >
                  ← Back to sign in
                </button>
              </form>
            </>
          )}

          {view === "resetSent" && (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
              </div>
              <div>
                <p className="font-semibold text-foreground">Check your email</p>
                <p className="text-sm text-muted-foreground mt-1">
                  A password reset link was sent to <span className="font-medium">{email}</span>.
                  Follow it to set a new password, then sign in here.
                </p>
              </div>
              <button
                type="button"
                className="mt-2 text-sm text-primary hover:underline"
                onClick={() => { setView("signIn"); setError(""); }}
              >
                Back to sign in
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
}
