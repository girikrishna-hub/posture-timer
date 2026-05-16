import { pgTable, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";

/**
 * native_sessions — server-side tracking for Android native auth sessions.
 *
 * Each row represents one active refresh session issued to a native client.
 * Access tokens are short-lived (30 min) and stateless; refresh sessions
 * are long-lived (90 days), server-tracked, and opaquely identified.
 *
 * Security properties:
 * - refreshTokenHash: SHA-256(refresh_token) — raw token never persisted
 * - rotation: hash updated on every refresh; replay of old token triggers compromise
 * - revocation: revokedAt makes the session immediately inert across all APIs
 * - compromise: compromisedFlag halts the refresh chain; requires reauthentication
 * - tokenVersion: increment to mass-invalidate access tokens for a session
 */
export const nativeSessionsTable = pgTable("native_sessions", {
  sessionId:        text("session_id").primaryKey(),
  userId:           text("user_id").notNull(),

  refreshTokenHash: text("refresh_token_hash").notNull(),

  deviceId:         text("device_id"),
  platform:         text("platform"),
  appVersion:       text("app_version"),

  tokenVersion:     integer("token_version").notNull().default(1),
  rotationCounter:  integer("rotation_counter").notNull().default(0),

  issuedAt:         timestamp("issued_at").notNull().defaultNow(),
  expiresAt:        timestamp("expires_at").notNull(),
  lastUsedAt:       timestamp("last_used_at").notNull().defaultNow(),

  revokedAt:        timestamp("revoked_at"),
  compromisedFlag:  boolean("compromised_flag").notNull().default(false),
});
