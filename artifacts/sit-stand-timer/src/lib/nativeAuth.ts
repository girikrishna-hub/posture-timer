/**
 * Native (Capacitor) auth bridge — module-level setup.
 *
 * Problem: In the Capacitor Android WebView the app is served from
 * https://localhost, so Clerk session cookies (set for posture-timer.replit.app)
 * are never attached to API requests → every call returns 401.
 *
 * Fix:
 *  1. Register a Bearer-token getter with customFetch *at import time* so it
 *     is in place before the very first TanStack Query fetch fires.
 *  2. Set the API base URL so relative paths like /api/... resolve to the
 *     production server instead of https://localhost.
 *  3. CapacitorAuthBridge (in App.tsx) wires the live Clerk getToken function
 *     into _getToken via bindClerkGetToken(), called from useLayoutEffect so
 *     it runs before TanStack Query's useEffect-based first fetch.
 *
 * Backend: no changes needed — @clerk/express clerkMiddleware already validates
 * Authorization: Bearer <jwt> in addition to cookie-based sessions.
 */

import { Capacitor } from "@capacitor/core";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";

export const IS_NATIVE = Capacitor.isNativePlatform();

/**
 * Reference to Clerk's getToken, updated by bindClerkGetToken().
 * Starts null — the getter returns null (→ no auth header) until Clerk loads.
 * That is safe because protected API calls only render inside <ClerkLoaded>.
 */
let _getToken: (() => Promise<string | null>) | null = null;

if (IS_NATIVE) {
  // Register the getter before any React renders.
  // Reading _getToken by reference means the closure always uses the latest
  // Clerk getToken after CapacitorAuthBridge's useLayoutEffect has run.
  setAuthTokenGetter(() => (_getToken ? _getToken() : null));

  // All /api/... calls must target the remote server.
  // VITE_API_BASE_URL is injected at build time via the build:android script.
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
  if (apiBase) {
    setBaseUrl(apiBase);
  }
}

/**
 * Called by CapacitorAuthBridge (useLayoutEffect) to bind or unbind the live
 * Clerk getToken function.  Pass null to clear on unmount / sign-out.
 */
export function bindClerkGetToken(fn: (() => Promise<string | null>) | null): void {
  _getToken = fn;
}
