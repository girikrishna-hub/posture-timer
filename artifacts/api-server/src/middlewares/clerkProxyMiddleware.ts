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

const CLERK_FAPI = "https://frontend-api.clerk.dev";
export const CLERK_PROXY_PATH = "/api/__clerk";

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
    const upstreamUrl = `${CLERK_FAPI}/npm${req.path}`;

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

export function clerkProxyMiddleware(): RequestHandler {
  // Only run proxy in production — Clerk proxying doesn't work for dev instances
  if (process.env.NODE_ENV !== "production") {
    return (_req, _res, next) => next();
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return (_req, _res, next) => next();
  }

  return createProxyMiddleware({
    target: CLERK_FAPI,
    changeOrigin: true,
    pathRewrite: (path: string) =>
      path.replace(new RegExp(`^${CLERK_PROXY_PATH}`), ""),
    on: {
      proxyReq: (proxyReq, req) => {
        const protocol = req.headers["x-forwarded-proto"] || "https";
        const host = getClerkProxyHost(req) || "";
        const proxyUrl = `${protocol}://${host}${CLERK_PROXY_PATH}`;

        proxyReq.setHeader("Clerk-Proxy-Url", proxyUrl);
        proxyReq.setHeader("Clerk-Secret-Key", secretKey);

        const xff = req.headers["x-forwarded-for"];
        const clientIp =
          (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() ||
          req.socket?.remoteAddress ||
          "";
        if (clientIp) {
          proxyReq.setHeader("X-Forwarded-For", clientIp);
        }
      },
      // Inject CORS headers into every proxied response so that Capacitor
      // Android WebViews (origin: capacitor://localhost) are not blocked.
      // The target (frontend-api.clerk.dev) may return its own ACAO header
      // that doesn't cover capacitor:// origins, so we override it here.
      proxyRes: (proxyRes, req) => {
        const origin = (req as { headers: Record<string, string | string[] | undefined> }).headers["origin"] as string | undefined;
        proxyRes.headers["access-control-allow-origin"] = origin || "*";
        proxyRes.headers["access-control-allow-credentials"] = "true";
        proxyRes.headers["access-control-allow-headers"] =
          "Content-Type, Authorization, Clerk-Backend-API-Version";
        proxyRes.headers["access-control-allow-methods"] =
          "GET, POST, PUT, PATCH, DELETE, OPTIONS";
      },
    },
  }) as RequestHandler;
}
