import { useState } from "react";
import { useSignIn } from "@clerk/react/legacy";

/**
 * Native (Capacitor) sign-in form using Clerk's useSignIn hook directly.
 *
 * Why not <SignIn routing="...">:
 *   After completing auth, Clerk's component navigates via window.location to
 *   the afterSignInUrl. In a Capacitor WebView this resolves as
 *   http://localhost/ which isn't served → "localhost refused connection".
 *
 * This component calls signIn.create() + setActive() instead. When the session
 * is created, Clerk updates isSignedIn → NativeAppShell re-renders to show the
 * app. Zero navigation required.
 */
export function NativeSignIn() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [view, setView] = useState<"signIn" | "forgotPassword" | "resetSent">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (!signIn || !setActive) return;
    setLoading(true);
    setError("");
    try {
      const result = await signIn.create({ identifier: email, password });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        // isSignedIn becomes true → NativeAppShell re-renders automatically.
        // No window.location navigation needed.
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
