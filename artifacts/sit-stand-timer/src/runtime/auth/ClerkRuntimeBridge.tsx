/**
 * ClerkRuntimeBridge — wires Clerk React hooks into AuthRuntime.
 *
 * This is the ONLY component that imports Clerk hooks. It binds them into
 * ClerkBridgeAdapter once they are available, then becomes a no-op.
 *
 * Placement: inside <ClerkProvider> but outside any auth gate, so Clerk
 * hooks are always available regardless of sign-in state.
 *
 * Also handles the deep-link ticket callback for the web OAuth fallback path.
 */

import { useEffect, useRef } from "react";
import { useSignIn } from "@clerk/react/legacy";
import { useAuth, useClerk } from "@clerk/react";
import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { AuthRuntime } from "./AuthRuntime";
import { IS_NATIVE } from "@/lib/nativeAuth";

export function ClerkRuntimeBridge() {
  const runtime = AuthRuntime.instance;
  const { signIn, setActive, isLoaded: signInLoaded } = useSignIn();
  const { getToken, isLoaded: authLoaded } = useAuth();
  const { signOut } = useClerk();
  const boundRef = useRef(false);

  // Bind Clerk hooks into the runtime adapter once both hooks are loaded
  useEffect(() => {
    if (!signInLoaded || !authLoaded) return;
    if (!signIn || !setActive) return;
    if (boundRef.current) return;
    boundRef.current = true;

    runtime.bindClerk({
      signIn: (params) =>
        signIn.create(params as Parameters<typeof signIn.create>[0]) as unknown as ReturnType<import("./ClerkBridgeAdapter").ClerkSignInFn>,
      setActive: (params) => setActive(params),
      getToken: () => getToken(),
      signOut: () => signOut(),
    });
  }, [signInLoaded, authLoaded, signIn, setActive, getToken, signOut, runtime]);

  // Deep-link handler for the web OAuth fallback path
  // (when native Google auth is unavailable)
  useEffect(() => {
    if (!IS_NATIVE) return;

    const handle = CapacitorApp.addListener("appUrlOpen", async (data) => {
      const url = data.url ?? "";
      if (!url.includes("posture-timer://oauth-callback")) return;

      try {
        const parsed = new URL(url);
        const ticket = parsed.searchParams.get("__clerk_ticket");
        if (!ticket) return;

        await Browser.close();
        await runtime.signInWithTicket(ticket);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        runtime.journal.record("AUTH_SIGN_IN_FAILED",
          `Deep-link ticket exchange failed: ${msg}`);
      }
    });

    return () => { handle.then((h) => h.remove()).catch(() => {}); };
  }, [runtime]);

  return null;
}
