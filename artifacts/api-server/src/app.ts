import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  clerkNpmBundleMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// CORS must be before the Clerk proxy so:
//   a) OPTIONS preflight requests are answered immediately (cors calls res.end())
//      and the proxy never sees them.
//   b) res.setHeader() calls from cors are in place before http-proxy-middleware
//      writes the response — Node's http layer merges them into writeHead().
// Without this, Android WebView (origin: capacitor://localhost) gets responses
// with no Access-Control-Allow-Origin header and blocks every Clerk FAPI call,
// keeping isLoaded=false forever.
app.use(cors({ credentials: true, origin: true }));

// npm bundle handler MUST be before the main proxy. It fetches Clerk's
// clerk-js and ui bundles server-side (following 307 redirects) so the
// Android WebView receives the final script body from our origin — no
// redirect to Clerk's CDN, no CORS exposure for capacitor://localhost.
app.use(`${CLERK_PROXY_PATH}/npm`, clerkNpmBundleMiddleware());
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey:
      publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ) ?? process.env.CLERK_PUBLISHABLE_KEY,
  })),
);

app.use("/api", router);

export default app;
