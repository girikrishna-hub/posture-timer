import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { nativeSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyNativeAccessToken } from "../routes/nativeAuth";

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
 * Native Android path (Authorization: Bearer <access-token>):
 *   1. Verify HS256 signature, expiry, issuer ("native-android"), audience ("posture-timer-api")
 *   2. Load the native_sessions row for the session_id claim
 *   3. Reject if: session not found, revoked, compromised, or token_version mismatch
 *   4. Set req.userId = JWT.sub (Clerk user ID) and continue
 *
 * Web path (fallback):
 *   No valid native JWT present → delegate to Clerk's getAuth(req) which reads
 *   the session cookie set by clerkMiddleware.
 *
 * All downstream route handlers read req.userId and are unaware of which path ran.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization ?? "";

  if (authHeader.startsWith("Bearer ")) {
    const secret = process.env.SESSION_SECRET ?? "";

    if (secret) {
      const claims = verifyNativeAccessToken(authHeader.slice(7), secret);

      if (claims) {
        // Validate session liveness in the server-side session store
        const session = await db.query.nativeSessionsTable
          .findFirst({ where: eq(nativeSessionsTable.sessionId, claims.session_id) })
          .catch(() => null);

        if (!session) {
          res.status(401).json({ error: "Session not found" });
          return;
        }
        if (session.revokedAt) {
          res.status(401).json({ error: "Session revoked" });
          return;
        }
        if (session.compromisedFlag) {
          res.status(401).json({ error: "Session compromised — reauthentication required" });
          return;
        }
        if (session.tokenVersion !== claims.token_version) {
          res.status(401).json({ error: "Token version invalidated" });
          return;
        }

        req.userId = claims.sub;
        next();
        return;
      }
    }
  }

  // Web path: Clerk session cookie (clerkMiddleware already ran)
  const { userId } = getAuth(req);
  if (!userId || userId.trim() === "") {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  next();
}
