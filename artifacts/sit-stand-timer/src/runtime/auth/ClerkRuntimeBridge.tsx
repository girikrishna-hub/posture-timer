/**
 * ClerkRuntimeBridge — native deep-link handler for OAuth fallback.
 *
 * HARDENED: This component no longer binds Clerk React hooks into the runtime.
 * ClerkBridgeAdapter now accesses window.Clerk directly (via ClerkSessionTransport)
 * without any React lifecycle dependency.
 *
 * This component's ONLY remaining responsibility is:
 * - Listen for appUrlOpen events (Clerk OAuth deep-link callbacks)
 * - Extract the __clerk_ticket parameter
 * - Hand it to AuthRuntime.signInWithTicket()
 *
 * It renders null. It is placed inside <ClerkProvider> so InternalClerkProvider
 * initializes the window.Clerk global, but ClerkRuntimeBridge itself uses no
 * Clerk hooks.
 */

import { useEffect } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { AuthRuntime } from "./AuthRuntime";
import { IS_NATIVE } from "@/lib/nativeAuth";

export function ClerkRuntimeBridge() {
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
        await AuthRuntime.instance.signInWithTicket(ticket);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        AuthRuntime.instance.journal.record(
          "AUTH_SIGN_IN_FAILED",
          `Deep-link ticket exchange failed: ${msg}`,
        );
      }
    });

    return () => { handle.then((h) => h.remove()).catch(() => {}); };
  }, []);

  return null;
}
