/**
 * Native Android auth routes.
 *
 * These endpoints are intentionally outside requireAuth — they ARE the auth path.
 *
 * POST /api/auth/native/google
 *   - Accepts a Google ID token from the native GoogleAuth plugin.
 *   - Verifies it with Google's tokeninfo API.
 *   - Finds or creates the matching Clerk user via BAPI.
 *   - Issues a signed HS256 native JWT (SESSION_SECRET).
 *
 * POST /api/auth/native/refresh
 *   - Accepts a valid native JWT (Authorization: Bearer).
 *   - Re-issues a fresh JWT with a new expiry.
 *
 * The native JWT payload:
 *   { iss: "native-android", sub: clerkUserId, sid, google_sub, iat, exp }
 *
 * requireAuth accepts these JWTs alongside Clerk session tokens so all
 * existing protected routes work without modification.
 */

import { Router } from "express";
import crypto from "node:crypto";
import { clerkClient } from "@clerk/express";

const router = Router();

const NATIVE_JWT_TTL_SECS = 7 * 24 * 60 * 60; // 7 days

// ── JWT helpers (HS256, no external dependency) ───────────────────────────────

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input as string, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function signNativeJwt(payload: Record<string, unknown>, secret: string): string {
  const header = b64url('{"alg":"HS256","typ":"JWT"}');
  const body   = b64url(JSON.stringify(payload));
  const data   = `${header}.${body}`;
  const sig    = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyNativeJwt(
  token: string,
  secret: string,
): { sub: string; sid: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const data     = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
    const eBuf     = Buffer.from(expected, "base64url");
    const aBuf     = Buffer.from(parts[2], "base64url");
    if (eBuf.length !== aBuf.length) return null;
    if (!crypto.timingSafeEqual(eBuf, aBuf)) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as {
      iss?: string;
      sub?: string;
      sid?: string;
      exp?: number;
      google_sub?: string;
    };

    if (payload.iss !== "native-android") return null;
    if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) return null;
    if (!payload.sub || !payload.sid) return null;

    return { sub: payload.sub, sid: payload.sid };
  } catch {
    return null;
  }
}

// ── Google tokeninfo response shape ──────────────────────────────────────────

interface GoogleTokenInfo {
  sub:            string;
  email:          string;
  email_verified: string;
  aud:            string;
  exp:            string;
  error?:         string;
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.post("/auth/native/google", async (req, res) => {
  const { idToken } = req.body as { idToken?: unknown };

  if (typeof idToken !== "string" || !idToken) {
    res.status(400).json({ error: "idToken required" });
    return;
  }

  // 1. Verify Google ID token via Google's public tokeninfo endpoint
  const googleRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
  ).catch((err: unknown) => {
    req.log.error({ err }, "tokeninfo fetch failed");
    return null;
  });

  if (!googleRes || !googleRes.ok) {
    req.log.warn({ status: googleRes?.status }, "Google tokeninfo rejected ID token");
    res.status(401).json({ error: "Invalid Google ID token" });
    return;
  }

  const info = await googleRes.json() as GoogleTokenInfo;

  if (info.error) {
    req.log.warn({ googleError: info.error }, "Google tokeninfo returned error field");
    res.status(401).json({ error: "Google token validation failed" });
    return;
  }

  const expectedAud = process.env.GOOGLE_FIT_CLIENT_ID ?? "";
  if (expectedAud && info.aud !== expectedAud) {
    req.log.warn({ aud: info.aud, expected: expectedAud }, "Google token aud mismatch");
    res.status(401).json({ error: "Token audience mismatch" });
    return;
  }

  const { sub: googleSub, email } = info;
  if (!email || !googleSub) {
    res.status(401).json({ error: "Missing email or sub in Google token" });
    return;
  }

  // 2. Find or create the Clerk user for this Google identity
  let clerkUserId: string;
  try {
    const list = await clerkClient.users.getUserList({ emailAddress: [email] });
    if (list.data.length > 0) {
      clerkUserId = list.data[0].id;
      req.log.info({ clerkUserId }, "native google exchange: found existing user");
    } else {
      const newUser = await clerkClient.users.createUser({
        emailAddress: [email],
        externalId:   googleSub,
        skipPasswordRequirement: true,
      });
      clerkUserId = newUser.id;
      req.log.info({ clerkUserId }, "native google exchange: created new user");
    }
  } catch (err) {
    req.log.error({ err }, "Clerk BAPI error during native google exchange");
    res.status(502).json({ error: "Auth provider error" });
    return;
  }

  // 3. Issue a native JWT signed with SESSION_SECRET
  const secret = process.env.SESSION_SECRET ?? "";
  if (!secret) {
    req.log.error("SESSION_SECRET not configured — cannot issue native JWT");
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  const now       = Math.floor(Date.now() / 1000);
  const exp       = now + NATIVE_JWT_TTL_SECS;
  const sessionId = crypto.randomUUID();

  const jwt = signNativeJwt(
    { iss: "native-android", sub: clerkUserId, sid: sessionId, google_sub: googleSub, iat: now, exp },
    secret,
  );

  res.json({ jwt, sessionId, userId: clerkUserId, expiresAt: exp * 1000 });
});

router.post("/auth/native/refresh", (req, res) => {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const secret  = process.env.SESSION_SECRET ?? "";
  const payload = verifyNativeJwt(auth.slice(7), secret);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + NATIVE_JWT_TTL_SECS;

  const newJwt = signNativeJwt(
    { iss: "native-android", sub: payload.sub, sid: payload.sid, iat: now, exp },
    secret,
  );

  res.json({ token: newJwt, expiresAt: exp * 1000 });
});

export default router;
