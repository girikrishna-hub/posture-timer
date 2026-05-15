/**
 * Native (Capacitor/Android) Clerk configuration — compile-time constants.
 *
 * WHY HARDCODED:
 * `VITE_CLERK_PUBLISHABLE_KEY` is only available as a Replit secret. When the
 * user runs `npm run build:android` on their local machine the env var is
 * absent and the APK ends up with publishableKey="" → clerk.browser.js never
 * loads → isLoaded stays false forever.
 *
 * The publishable key is NOT sensitive — it is a "publishable" key by design,
 * meant to be embedded in client-side code and visible to anyone who inspects
 * the bundle.  We keep VITE_CLERK_PUBLISHABLE_KEY as the preferred source (so
 * Replit-managed key rotation / pk_live_ swap still works), with the hardcoded
 * value as the local-build fallback.
 *
 * NATIVE_CLERK_PROXY_URL:
 * clerk.posture-timer.replit.app is a Replit-internal hostname that is not
 * reachable from an Android device.  All FAPI calls must go through our
 * Express reverse proxy at posture-timer.replit.app/api/__clerk.
 *
 * NATIVE_CLERK_JS_URL:
 * Clerk's own bundle CDN responds with 307 redirects that WebView can't follow
 * for cross-origin fetches.  jsDelivr serves an exact-version build directly
 * with CORS headers that work in both WebView and Custom Tabs.
 */

export const NATIVE_CLERK_PUBLISHABLE_KEY: string =
  (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) ??
  "pk_test_dGlkeS10dXJ0bGUtMjEuY2xlcmsuYWNjb3VudHMuZGV2JA";

export const NATIVE_CLERK_PROXY_URL =
  "https://posture-timer.replit.app/api/__clerk";

// Clerk-js 6.10.1 — matches the version pinned in @clerk/shared@4.10.2.
// Exact version avoids jsDelivr redirect chains and is always reachable.
export const NATIVE_CLERK_JS_URL =
  "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.10.1/dist/clerk.browser.js";
