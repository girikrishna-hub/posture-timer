import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { verifyNativeJwt } from "../routes/nativeAuth";

declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

/**
 * requireAuth — validates either a native JWT or a Clerk session token.
 *
 * Native Android path:
 *   The Capacitor app sends "Authorization: Bearer <native-jwt>" on every request.
 *   verifyNativeJwt() checks the HS256 signature + expiry + issuer claim.
 *   On success, req.userId is set from the JWT's `sub` (Clerk user ID) and the
 *   handler is called without touching the Clerk middleware at all.
 *
 * Web path (fallback):
 *   No native JWT present → Clerk's getAuth(req) resolves the session from the
 *   cookie/header that clerkMiddleware has already populated.
 *
 * All downstream route handlers read req.userId — they are unaware of which
 * auth path was taken.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization ?? "";

  if (auth.startsWith("Bearer ")) {
    const secret = process.env.SESSION_SECRET ?? "";
    if (secret) {
      const payload = verifyNativeJwt(auth.slice(7), secret);
      if (payload) {
        req.userId = payload.sub;
        next();
        return;
      }
    }
  }

  const { userId } = getAuth(req);
  if (!userId || userId.trim() === "") {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  next();
}
