/**
 * AuthProviderError — typed error for provider-side auth failures.
 *
 * Distinguishes between:
 * - REVOKED: Google account access revoked by user or admin
 * - INVALID_TOKEN: ID token rejected (expired, malformed, wrong audience)
 * - SESSION_INVALIDATED: Clerk session invalidated server-side (force sign-out)
 * - PROVIDER_REMOVED: Google account unlinked from Clerk user
 * - TRANSIENT: Temporary network/server error — eligible for retry
 *
 * Used by ClerkBridgeAdapter and AuthSessionManager to skip retries on
 * non-retriable errors and transition directly to SIGNED_OUT / INVALID.
 *
 * IMPORTANT: Error messages must NEVER include JWT values, tokens, or
 * email addresses — they may appear in crash reports or stack traces.
 */

export type AuthProviderErrorCode =
  | "REVOKED"
  | "INVALID_TOKEN"
  | "SESSION_INVALIDATED"
  | "PROVIDER_REMOVED"
  | "TRANSIENT";

export class AuthProviderError extends Error {
  readonly code: AuthProviderErrorCode;
  /** True → skip all retry; force sign-out or re-auth immediately */
  readonly isNonRetriable: boolean;

  constructor(code: AuthProviderErrorCode, message: string) {
    super(message);
    this.name = "AuthProviderError";
    this.code = code;
    this.isNonRetriable =
      code === "REVOKED" ||
      code === "SESSION_INVALIDATED" ||
      code === "PROVIDER_REMOVED";
  }
}

// ── Clerk error shape ──────────────────────────────────────────────────────

interface ClerkErrorShape {
  clerkError?: boolean;
  errors?: Array<{ code?: string; message?: string }>;
  status?: number;
}

/**
 * Detect non-retriable provider errors from Clerk SDK exceptions.
 * These codes indicate the session or provider grant is permanently gone.
 *
 * Clerk error codes that indicate permanent invalidation:
 * - session_not_found       — session revoked server-side
 * - session_token_outdated  — server forced invalidation
 * - oauth_access_token_invalid — Google revoked OAuth grant
 * - external_account_not_found — Google account unlinked from Clerk user
 * - provider_not_linked       — Google provider removed from account
 * - token_invalid             — ID token rejected
 */
const REVOKED_CODES = new Set([
  "session_not_found",
  "session_token_outdated",
  "oauth_access_token_invalid",
  "external_account_not_found",
  "provider_not_linked",
]);

const INVALID_TOKEN_CODES = new Set([
  "token_invalid",
  "token_verification_failed",
  "jwt_invalid",
  "jwt_expired",
]);

export function classifyClerkError(err: unknown): AuthProviderError | null {
  // Pass-through: AuthProviderError thrown directly by NativeSessionTransport
  // (e.g. on revoked/compromised/replay session) is returned as-is so that
  // AuthSessionManager's revocation path fires without any string matching.
  if (err instanceof AuthProviderError) {
    return err;
  }

  if (!err || typeof err !== "object") return null;

  const e = err as ClerkErrorShape & { message?: string };

  // Null return from getToken() — session gone
  if (err === null) {
    return new AuthProviderError("SESSION_INVALIDATED", "Clerk getToken returned null — session gone");
  }

  // Clerk structured error
  if (e.clerkError && e.errors && e.errors.length > 0) {
    const code = e.errors[0].code ?? "";
    if (REVOKED_CODES.has(code)) {
      return new AuthProviderError("REVOKED", `Clerk: ${code}`);
    }
    if (INVALID_TOKEN_CODES.has(code)) {
      return new AuthProviderError("INVALID_TOKEN", `Clerk: ${code}`);
    }
    // HTTP 401 from Clerk usually means session gone
    if (e.status === 401) {
      return new AuthProviderError("SESSION_INVALIDATED", "Clerk 401 — session invalidated");
    }
  }

  // String-match fallback for non-structured Clerk errors
  const msg = (e.message ?? "").toLowerCase();
  if (
    msg.includes("session_not_found") ||
    msg.includes("session not found") ||
    msg.includes("session has been revoked") ||
    msg.includes("oauth_access_token_invalid")
  ) {
    return new AuthProviderError("REVOKED", "Clerk session revoked (string match)");
  }

  if (
    msg.includes("token_invalid") ||
    msg.includes("invalid token") ||
    msg.includes("jwt") && msg.includes("invalid")
  ) {
    return new AuthProviderError("INVALID_TOKEN", "Token rejected by Clerk (string match)");
  }

  return null; // treat as TRANSIENT — eligible for retry
}

/**
 * Classify errors from Google Sign-In plugin.
 * Google errors that indicate permanent access loss:
 * - 12501 (SIGN_IN_CANCELLED) — user dismissed (not an error)
 * - 10 (DEVELOPER_ERROR) — SHA-1 mismatch or misconfiguration
 * - 7 (NETWORK_ERROR) — transient
 * - Access revoked errors from the token exchange
 */
export function classifyGoogleError(err: unknown): AuthProviderError | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: number | string; message?: string };
  const msg = (e.message ?? "").toLowerCase();
  const code = e.code;

  // Developer error — SHA-1/package mismatch: hard failure, not a user revocation
  if (code === 10 || msg.includes("developer_error") || msg.includes("sha-1")) {
    return new AuthProviderError(
      "INVALID_TOKEN",
      "Google Sign-In configuration error (code 10) — SHA-1 or package mismatch"
    );
  }

  // Access revoked by user in Google account settings
  if (msg.includes("access_denied") || msg.includes("revoked")) {
    return new AuthProviderError("REVOKED", "Google access revoked");
  }

  if (msg.includes("account_removed") || msg.includes("account not found")) {
    return new AuthProviderError("PROVIDER_REMOVED", "Google account removed or unlinked");
  }

  return null;
}
