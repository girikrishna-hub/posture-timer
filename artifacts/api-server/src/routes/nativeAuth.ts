/**
 * Native Android auth routes — hardened session security model.
 *
 * Token architecture:
 *   Access tokens  — short-lived HS256 JWT (30 min)
 *                    claims: { iss, aud, sub, session_id, token_version, iat, exp }
 *   Refresh tokens — opaque 32-byte random hex string
 *                    stored server-side as SHA-256(token), never logged
 *                    rotated on every refresh; replay of old token = compromise
 *
 * Replay protection:
 *   On refresh, if the incoming hash ≠ stored hash for that session_id,
 *   the session is immediately marked compromised + revoked. The client
 *   receives SESSION_INVALIDATED and must re-authenticate from scratch.
 *
 * Device binding:
 *   deviceId / platform / appVersion are stored for anomaly attribution.
 *   They are not enforced as a hard auth gate in this revision.
 *
 * Routes (all outside requireAuth — these ARE the auth boundary):
 *   POST /api/auth/native/google   — initial session establishment
 *   POST /api/auth/native/refresh  — token rotation (access + refresh)
 *   POST /api/auth/native/revoke   — explicit session termination
 */

import { Router } from "express";
import crypto from "node:crypto";
import { clerkClient } from "@clerk/express";
import { db } from "@workspace/db";
import { nativeSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL_SECS   = 30 * 60;              // 30 minutes
const REFRESH_SESSION_TTL_MS  = 90 * 24 * 60 * 60 * 1000; // 90 days

export const NATIVE_ISSUER   = "native-android";
export const NATIVE_AUDIENCE = "posture-timer-api";

// ── Cryptographic primitives ──────────────────────────────────────────────────

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input as string, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function signAccessToken(payload: Record<string, unknown>, secret: string): string {
  const header = b64url('{"alg":"HS256","typ":"JWT"}');
  const body   = b64url(JSON.stringify(payload));
  const data   = `${header}.${body}`;
  const sig    = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export interface AccessTokenClaims {
  sub:           string;
  session_id:    string;
  token_version: number;
  exp:           number;
}

export function verifyNativeAccessToken(
  token: string,
  secret: string,
): AccessTokenClaims | null {
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
      iss?: string; aud?: string; sub?: string;
      session_id?: string; token_version?: number; exp?: number;
    };

    if (payload.iss !== NATIVE_ISSUER)   return null;
    if (payload.aud !== NATIVE_AUDIENCE) return null;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (
      !payload.sub ||
      !payload.session_id ||
      typeof payload.token_version !== "number"
    ) return null;

    return {
      sub:           payload.sub,
      session_id:    payload.session_id,
      token_version: payload.token_version,
      exp:           payload.exp ?? 0,
    };
  } catch {
    return null;
  }
}

function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function safeHashEqual(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

// ── Google token validation ───────────────────────────────────────────────────

interface GoogleTokenInfo {
  sub?:            string;
  email?:          string;
  email_verified?: string;
  aud?:            string;
  exp?:            string;
  iss?:            string;
  error?:          string;
}

const GOOGLE_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);

async function verifyGoogleIdToken(
  idToken: string,
  expectedAud: string,
): Promise<{ sub: string; email: string } | null> {
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
  ).catch(() => null);

  if (!res?.ok) return null;

  const info = await res.json() as GoogleTokenInfo;
  if (info.error) return null;

  if (!info.iss || !GOOGLE_ISSUERS.has(info.iss)) return null;
  if (expectedAud && info.aud !== expectedAud)    return null;
  if (info.email_verified !== "true")             return null;

  const exp = info.exp ? parseInt(info.exp, 10) : 0;
  if (exp > 0 && exp < Math.floor(Date.now() / 1000)) return null;

  if (!info.sub || !info.email) return null;

  return { sub: info.sub, email: info.email };
}

// ── POST /api/auth/native/google ──────────────────────────────────────────────

router.post("/auth/native/google", async (req, res) => {
  const body = req.body as {
    idToken?:    unknown;
    deviceId?:   unknown;
    platform?:   unknown;
    appVersion?: unknown;
  };

  if (typeof body.idToken !== "string" || !body.idToken) {
    res.status(400).json({ error: "idToken required" });
    return;
  }

  const secret = process.env.SESSION_SECRET ?? "";
  if (!secret) {
    req.log.error("SESSION_SECRET not configured");
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  // 1. Validate Google ID token (issuer + audience + email_verified + expiry)
  const expectedAud = process.env.GOOGLE_FIT_CLIENT_ID ?? "";
  const identity = await verifyGoogleIdToken(body.idToken, expectedAud);
  if (!identity) {
    req.log.warn("Google ID token validation failed");
    res.status(401).json({ error: "Invalid Google ID token" });
    return;
  }

  // 2. Resolve Clerk user (find by email or create)
  let clerkUserId: string;
  try {
    const list = await clerkClient.users.getUserList({
      emailAddress: [identity.email],
    });
    if (list.data.length > 0) {
      clerkUserId = list.data[0].id;
    } else {
      const created = await clerkClient.users.createUser({
        emailAddress:            [identity.email],
        externalId:              identity.sub,
        skipPasswordRequirement: true,
      });
      clerkUserId = created.id;
    }
    req.log.info({ clerkUserId }, "native google exchange: user resolved");
  } catch (err) {
    req.log.error({ err }, "Clerk BAPI error during native google exchange");
    res.status(502).json({ error: "Auth provider error" });
    return;
  }

  // 3. Create server-tracked refresh session
  const sessionId    = crypto.randomUUID();
  const refreshToken = generateRefreshToken();
  const tokenVersion = 1;
  const now          = new Date();
  const expiresAt    = new Date(now.getTime() + REFRESH_SESSION_TTL_MS);

  await db.insert(nativeSessionsTable).values({
    sessionId,
    userId:           clerkUserId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    deviceId:         typeof body.deviceId   === "string" ? body.deviceId   : null,
    platform:         typeof body.platform   === "string" ? body.platform   : null,
    appVersion:       typeof body.appVersion === "string" ? body.appVersion : null,
    tokenVersion,
    rotationCounter:  0,
    issuedAt:         now,
    expiresAt,
    lastUsedAt:       now,
  });

  // 4. Issue short-lived access token
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ACCESS_TOKEN_TTL_SECS;

  const accessToken = signAccessToken(
    {
      iss:           NATIVE_ISSUER,
      aud:           NATIVE_AUDIENCE,
      sub:           clerkUserId,
      session_id:    sessionId,
      token_version: tokenVersion,
      iat,
      exp,
    },
    secret,
  );

  res.json({
    accessToken,
    refreshToken,     // opaque — never log
    sessionId,
    userId: clerkUserId,
    expiresAt: exp * 1000,
  });
});

// ── POST /api/auth/native/refresh ─────────────────────────────────────────────

router.post("/auth/native/refresh", async (req, res) => {
  const body = req.body as { refreshToken?: unknown; sessionId?: unknown };

  if (typeof body.refreshToken !== "string" || typeof body.sessionId !== "string") {
    res.status(400).json({ error: "refreshToken and sessionId required" });
    return;
  }

  const secret = process.env.SESSION_SECRET ?? "";

  // 1. Load session record
  const session = await db.query.nativeSessionsTable
    .findFirst({ where: eq(nativeSessionsTable.sessionId, body.sessionId) })
    .catch(() => null);

  if (!session) {
    res.status(401).json({ error: "Session not found" });
    return;
  }

  // 2. Validate session health
  if (session.revokedAt) {
    res.status(401).json({ error: "Session revoked" });
    return;
  }
  if (session.compromisedFlag) {
    req.log.warn({ sessionId: session.sessionId }, "Refresh attempted on compromised session");
    res.status(401).json({ error: "Session compromised — reauthentication required" });
    return;
  }
  if (session.expiresAt < new Date()) {
    res.status(401).json({ error: "Session expired" });
    return;
  }

  // 3. Constant-time refresh token validation
  const incomingHash = hashRefreshToken(body.refreshToken);
  const hashMatch    = safeHashEqual(incomingHash, session.refreshTokenHash);

  if (!hashMatch) {
    // Hash mismatch → replay of an already-rotated token → compromise the session
    await db.update(nativeSessionsTable)
      .set({ compromisedFlag: true, revokedAt: new Date() })
      .where(eq(nativeSessionsTable.sessionId, session.sessionId));

    req.log.warn(
      { sessionId: session.sessionId, userId: session.userId },
      "SECURITY: refresh token replay detected — session revoked and marked compromised",
    );
    res.status(401).json({ error: "Replay detected — reauthentication required" });
    return;
  }

  // 4. Rotate: issue new refresh token, invalidate old one atomically
  const newRefreshToken = generateRefreshToken();
  const now             = new Date();

  await db.update(nativeSessionsTable)
    .set({
      refreshTokenHash: hashRefreshToken(newRefreshToken),
      rotationCounter:  session.rotationCounter + 1,
      lastUsedAt:       now,
    })
    .where(eq(nativeSessionsTable.sessionId, session.sessionId));

  // 5. Issue new short-lived access token
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ACCESS_TOKEN_TTL_SECS;

  const accessToken = signAccessToken(
    {
      iss:           NATIVE_ISSUER,
      aud:           NATIVE_AUDIENCE,
      sub:           session.userId,
      session_id:    session.sessionId,
      token_version: session.tokenVersion,
      iat,
      exp,
    },
    secret,
  );

  res.json({
    accessToken,
    refreshToken: newRefreshToken,  // new opaque token; old is now permanently invalid
    expiresAt:    exp * 1000,
  });
});

// ── POST /api/auth/native/revoke ──────────────────────────────────────────────

router.post("/auth/native/revoke", async (req, res) => {
  const body = req.body as { refreshToken?: unknown; sessionId?: unknown };

  if (typeof body.refreshToken !== "string" || typeof body.sessionId !== "string") {
    res.status(400).json({ error: "refreshToken and sessionId required" });
    return;
  }

  const session = await db.query.nativeSessionsTable
    .findFirst({ where: eq(nativeSessionsTable.sessionId, body.sessionId) })
    .catch(() => null);

  // Already gone or doesn't exist — idempotent success
  if (!session || session.revokedAt) {
    res.json({ revoked: true });
    return;
  }

  // Require proof-of-possession before revoking to prevent enumeration/DoS
  const hashMatch = safeHashEqual(
    hashRefreshToken(body.refreshToken),
    session.refreshTokenHash,
  );
  if (!hashMatch) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  await db.update(nativeSessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(nativeSessionsTable.sessionId, body.sessionId));

  req.log.info({ sessionId: body.sessionId }, "native session explicitly revoked");
  res.json({ revoked: true });
});

export default router;
