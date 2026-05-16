/**
 * ClerkRuntimeBridge — native deep-link handler + Clerk readiness signal.
 *
 * HARDENED (Phase 3):
 * - Explicitly signals ClerkRuntimeRegistry when Clerk JS becomes available.
 *   This provides a React-layer confirmation in addition to the registry's
 *   internal 50ms watcher, guaranteeing faster and more reliable readiness
 *   notification with zero redundant polling.
 * - Remains the ONLY runtime responsibility for deep-link (OAuth callback) handling.
 * - Still renders null and is still placed inside <ClerkProvider>.
 *
 * Signal flow:
 *   InternalClerkProvider loads Clerk JS
 *   → window.Clerk.loaded becomes true
 *   → ClerkRuntimeRegistry internal watcher fires (up to 50ms later)
 *   → ClerkRuntimeBridge.useEffect also fires (parallel confirmation)
 *   → ClerkRuntimeRegistry resolves its waitForReady() promise
 *   → All waiters (ClerkSessionTransport.waitForReady, boot sequence) unblock
 */

import { useEffect } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { AuthRuntime } from "./AuthRuntime";
import { ClerkRuntimeRegistry } from "./ClerkRuntimeRegistry";
import { IS_NATIVE } from "@/lib/nativeAuth";

export function ClerkRuntimeBridge() {
  // Signal Clerk readiness to the registry as soon as this component mounts.
  // By the time ClerkRuntimeBridge mounts, InternalClerkProvider has loaded
  // Clerk JS, so window.Clerk.loaded is either already true or will be shortly.
  useEffect(() => {
    const registry = ClerkRuntimeRegistry.instance;

    if ((window as { Clerk?: { loaded?: boolean } }).Clerk?.loaded) {
      // Already loaded — signal immediately
      registry.signal("CLERK_RUNTIME_AVAILABLE");
      return;
    }

    // Wait for Clerk to become ready with a short targeted check.
    // This is a single one-shot poll that terminates as soon as Clerk is ready.
    // The registry's internal 50ms watcher runs in parallel as the primary watcher.
    let cancelled = false;
    const check = setInterval(() => {
      if (cancelled) { clearInterval(check); return; }
      if ((window as { Clerk?: { loaded?: boolean } }).Clerk?.loaded) {
        clearInterval(check);
        registry.signal("CLERK_RUNTIME_AVAILABLE");
      }
    }, 50);

    return () => {
      cancelled = true;
      clearInterval(check);
    };
  }, []);

  // Deep-link handler for OAuth fallback (native only)
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
