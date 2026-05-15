/**
 * Clerk Frontend API Proxy Middleware
 *
 * Proxies Clerk Frontend API requests through your domain, enabling Clerk
 * authentication on custom domains and .replit.app deployments without
 * requiring CNAME DNS configuration.
 *
 * AUTH CONFIGURATION: To manage users, enable/disable login providers
 * (Google, GitHub, etc.), change app branding, or configure OAuth credentials,
 * use the Auth pane in the workspace toolbar. There is no external Clerk
 * dashboard — all auth configuration is done through the Auth pane.
 *
 * IMPORTANT:
 * - Only active in production (Clerk proxying doesn't work for dev instances)
 * - Must be mounted BEFORE express.json() middleware
 *
 * Usage in app.ts:
 *   import { CLERK_PROXY_PATH, clerkProxyMiddleware, clerkNpmBundleMiddleware }
 *     from "./middlewares/clerkProxyMiddleware";
 *   // Mount npm bundle handler FIRST (handles redirect-following for UI bundle)
 *   app.use(`${CLERK_PROXY_PATH}/npm`, clerkNpmBundleMiddleware());
 *   app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
 */

import { createProxyMiddleware } from "http-proxy-middleware";
import type { RequestHandler, Request, Response, NextFunction } from "express";
import type { IncomingHttpHeaders } from "http";

// The npm bundle CDN is always on the production Clerk FAPI.
const CLERK_CDN_FAPI = "https://frontend-api.clerk.dev";
export const CLERK_PROXY_PATH = "/api/__clerk";

/**
 * Extracts the instance-specific Clerk FAPI base URL from a publishable key.
 *
 * Clerk encodes the FAPI domain as base64 inside the key:
 *   pk_test_BASE64  →  decoded = "tidy-turtle-21.clerk.accounts.dev$"
 *   pk_live_BASE64  →  decoded = "instance.clerk.accounts.prod$"
 *
 * Dev instances MUST be proxied to their own FAPI subdomain
 * (tidy-turtle-21.clerk.accounts.dev) rather than frontend-api.clerk.dev.
 * The production FAPI does NOT host /v1/dev_browser and returns
 * instance_type_invalid for dev-only endpoints, which prevents Clerk.load()
 * from completing and keeps isLoaded=false permanently.
 */
function parseFapiUrl(publishableKey: string): string {
  const fallback = CLERK_CDN_FAPI;
  if (!publishableKey) return fallback;
  const b64 = publishableKey.replace(/^pk_(test|live)_/, "");
  if (!b64) return fallback;
  try {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    const domain = decoded.replace(/\$$/, "").trim();
    if (!domain || !domain.includes(".")) return fallback;
    return `https://${domain}`;
  } catch {
    return fallback;
  }
}

/**
 * Returns the first effective public hostname for the given request,
 * preferring x-forwarded-host over the Host header so callers behind a
 * proxy see the original client-facing host.
 *
 * x-forwarded-host can take three shapes:
 *   - undefined (no proxy involved)
 *   - a single string (one proxy hop)
 *   - a comma-delimited string when an upstream appended rather than
 *     replaced the header (Node folds duplicate headers this way), or a
 *     string[] in some Express typings
 * In the multi-value case, the leftmost value is the original client-
 * facing host. Take that one in all forms. Exported so that app.ts
 * (clerkMiddleware callback) and this proxy middleware agree on which
 * hostname is canonical — otherwise multi-domain/custom-domain flows
 * break.
 */
export function getClerkProxyHost(req: {
  headers: IncomingHttpHeaders;
}): string | undefined {
  const forwarded = req.headers["x-forwarded-host"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const firstHop = raw?.split(",")[0]?.trim();
  return firstHop || req.headers.host?.trim() || undefined;
}

/**
 * Serves Clerk npm bundles (clerk-js, @clerk/ui) by fetching them from
 * frontend-api.clerk.dev server-side, following any 307/302 redirects.
 *
 * ROOT CAUSE THIS FIXES — isLoaded permanently false on Android:
 *
 *   IsomorphicClerk.getEntryChunks() calls getClerkUIEntryChunk() which
 *   injects a <script crossorigin="anonymous"> pointing to the proxy path:
 *     /api/__clerk/npm/@clerk/ui@1/dist/ui.browser.js
 *
 *   http-proxy-middleware passes the upstream 307 redirect straight to the
 *   Android WebView. The WebView follows the redirect to Clerk's CDN with
 *   Origin: capacitor://localhost. If the CDN doesn't CORS-respond to that
 *   scheme, the script fails (CORS error on the crossorigin script element).
 *
 *   After 15 s, waitForPredicateWithTimeout rejects → getEntryChunks() catch
 *   fires → replayInterceptedInvocations() is never called → this.clerkjs
 *   stays null → clerk.loaded is false → useAuth().isLoaded stays false.
 *
 * FIX: Node 24's built-in fetch follows redirects automatically (redirect:
 * "follow" is the default). We fetch the bundle server-side, inject our own
 * CORS headers, and send the body directly. The Android WebView receives the
 * final script content from our origin — no redirect, no CDN CORS exposure.
 *
 * Mounted at CLERK_PROXY_PATH/npm so req.path is relative to that prefix,
 * e.g. /@clerk/ui@1/dist/ui.browser.js.
 * Must be registered BEFORE clerkProxyMiddleware() in app.ts.
 */
export function clerkNpmBundleMiddleware(): RequestHandler {
  if (process.env.NODE_ENV !== "production") {
    return (_req, _res, next) => next();
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    // npm bundles are always fetched from the production CDN FAPI —
    // they are static JS files, not instance-specific API calls.
    const upstreamUrl = `${CLERK_CDN_FAPI}/npm${req.path}`;

    try {
      const upstream = await fetch(upstreamUrl, {
        redirect: "follow",
        headers: { "User-Agent": "clerk-npm-proxy/1.0" },
      });

      if (!upstream.ok) {
        return next();
      }

      const body = await upstream.arrayBuffer();
      const origin = (req.headers.origin as string | undefined) ?? "*";

      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Credentials", "true");
      res.set(
        "Content-Type",
        upstream.headers.get("content-type") ??
          "application/javascript; charset=utf-8",
      );
      res.set("Cache-Control", "public, max-age=3600");
      res.send(Buffer.from(body));
    } catch {
      next();
    }
  };
}

// Headers that must not be forwarded to the upstream (hop-by-hop).
const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "transfer-encoding",
  "upgrade", "proxy-authorization", "te", "trailers",
]);

// Headers that must not be copied from the upstream response to our response.
const SKIP_RESPONSE = new Set([
  "transfer-encoding", "connection", "keep-alive",
]);

export function clerkProxyMiddleware(): RequestHandler {
  // Only run proxy in production — Clerk proxying doesn't work for dev instances
  if (process.env.NODE_ENV !== "production") {
    return (_req, _res, next) => next();
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return (_req, _res, next) => next();
  }

  // Derive the correct FAPI target from the publishable key.
  //
  // CRITICAL: for dev instances (pk_test_*) the FAPI is instance-specific
  // (e.g. tidy-turtle-21.clerk.accounts.dev), NOT frontend-api.clerk.dev.
  // Proxying to the wrong FAPI causes /v1/dev_browser → 400 instance_type_invalid,
  // which prevents Clerk.load() from completing → isLoaded stays false permanently.
  //
  // For live instances (pk_live_*) the decoded domain may be an internal Clerk
  // routing identifier rather than a public endpoint — fall back to the standard
  // production FAPI in that case.
  const publishableKey =
    process.env.CLERK_PUBLISHABLE_KEY ??
    process.env.VITE_CLERK_PUBLISHABLE_KEY ??
    "";
  const clerkFapi = parseFapiUrl(publishableKey);

  // Use a direct fetch-based proxy instead of http-proxy-middleware.
  //
  // Why: http-proxy-middleware opens a persistent TCP connection to the upstream
  // and can silently fail in Replit's production network with a 504 when the
  // target domain changes. Node's built-in fetch uses its own connection pool,
  // follows redirects natively, and gives us structured error objects (code,
  // message) instead of an opaque "Error occurred while trying to proxy" string.
  // This also lets us log the exact upstream URL and response body on failure.
  return async (req: Request, res: Response, _next: NextFunction) => {
    // Express strips the /api/__clerk mount prefix, so req.url starts with /v1/...
    const upstreamUrl = `${clerkFapi}${req.url}`;

    // Collect raw request body for non-idempotent methods.
    // clerkProxyMiddleware is mounted BEFORE express.json(), so the stream
    // has not been consumed by any body parser yet.
    let bodyBuf: Buffer | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      bodyBuf = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    }

    // Build forwarding headers: copy everything except hop-by-hop headers.
    const fwd: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      fwd[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
    }

    // Override Host to match the upstream target (required for TLS SNI).
    fwd["host"] = new URL(clerkFapi).host;

    // Apply Origin stripping rules (same logic as before).
    // Non-HTTP origins (capacitor://, https://localhost) are always stripped.
    // POST /sign_ups keeps an https:// Origin for bot-protection.
    // Everything else strips Origin.
    const requestOrigin = req.headers["origin"] as string | undefined;
    const isHttpOrigin =
      typeof requestOrigin === "string" &&
      (requestOrigin.startsWith("https://") || requestOrigin.startsWith("http://"));
    const isSignUp = req.method === "POST" && (req.path ?? "").includes("/sign_ups");
    if (!isHttpOrigin || !isSignUp) {
      delete fwd["origin"];
    }

    // Required Clerk proxy identification headers.
    const protocol = (req.headers["x-forwarded-proto"] as string | undefined) || "https";
    const host = getClerkProxyHost(req) || "";
    fwd["clerk-proxy-url"] = `${protocol}://${host}${CLERK_PROXY_PATH}`;
    fwd["clerk-secret-key"] = secretKey;

    // Forward client IP.
    const xff = req.headers["x-forwarded-for"];
    const clientIp =
      (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "";
    if (clientIp) fwd["x-forwarded-for"] = clientIp;

    // Fix Content-Length now that we've read the body into a Buffer.
    if (bodyBuf !== undefined) {
      if (bodyBuf.length > 0) {
        fwd["content-length"] = String(bodyBuf.length);
      } else {
        delete fwd["content-length"];
        bodyBuf = undefined;
      }
    }

    req.log.info({ upstreamUrl, method: req.method, fapi: clerkFapi },
      "[clerk-proxy] forwarding to upstream");

    try {
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers: fwd,
        body: bodyBuf ?? null,
      });

      // Log non-OK responses including the body so they appear in deployment logs.
      if (!upstream.ok) {
        let errBody = "(unreadable)";
        try { errBody = await upstream.clone().text(); } catch { /* ignore */ }
        req.log.warn(
          { upstreamUrl, status: upstream.status, body: errBody.slice(0, 500) },
          "[clerk-proxy] upstream returned non-OK",
        );
      }

      // Forward status and response headers.
      res.status(upstream.status);
      for (const [k, v] of upstream.headers.entries()) {
        if (!SKIP_RESPONSE.has(k.toLowerCase())) res.setHeader(k, v);
      }

      // Override CORS so Capacitor WebViews (origin: https://localhost or
      // capacitor://localhost) are not blocked by Clerk's own ACAO header.
      const origin = req.headers["origin"] as string | undefined;
      res.setHeader("access-control-allow-origin", origin || "*");
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("access-control-allow-headers",
        "Content-Type, Authorization, Clerk-Backend-API-Version");
      res.setHeader("access-control-allow-methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS");

      const responseBody = await upstream.arrayBuffer();
      res.send(Buffer.from(responseBody));
    } catch (err) {
      const msg   = err instanceof Error ? err.message : String(err);
      const code  = (err as NodeJS.ErrnoException).code ?? "unknown";
      req.log.error(
        { err, upstreamUrl, clerkFapi, code },
        `[clerk-proxy] upstream fetch failed: ${code} — ${msg}`,
      );
      // Return a structured error body so the debug panel can show details.
      res.status(502).json({
        error: "clerk_proxy_failed",
        code,
        message: msg,
        upstream: upstreamUrl,
      });
    }
  };
}
