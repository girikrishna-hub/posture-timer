/**
 * AuthConfidenceLevel — explicit model for how trustworthy the current session is.
 *
 * Avoids binary authenticated/not-authenticated thinking. The runtime always
 * knows not just WHETHER a session exists, but HOW much it should trust it.
 *
 * Consumers use this to decide:
 * - VERIFIED / RECOVERED: show full app
 * - DEGRADED / OFFLINE_ONLY: show app with banner warning
 * - RECOVERY_REQUIRED: trigger refresh before continuing
 * - INVALID: sign out / show auth screen
 */

export type AuthConfidenceLevel =
  /** Fresh JWT, recently verified against backend. Highest trust. */
  | "VERIFIED"

  /** Session restored from persistence, JWT freshly refreshed. Full trust. */
  | "RECOVERED"

  /** Session known, JWT stale or last refresh failed. Reduced trust. */
  | "DEGRADED"

  /** Session known, backend unreachable. Can operate on cached data only. */
  | "OFFLINE_ONLY"

  /** Session likely expired or near-expired. Refresh required before API calls. */
  | "RECOVERY_REQUIRED"

  /** No valid session, or session definitively invalid. Must re-authenticate. */
  | "INVALID";

/**
 * Returns true for confidence levels that allow full API access.
 */
export function isFullyOperational(level: AuthConfidenceLevel): boolean {
  return level === "VERIFIED" || level === "RECOVERED";
}

/**
 * Returns true for confidence levels that allow degraded/offline operation.
 */
export function isPartiallyOperational(level: AuthConfidenceLevel): boolean {
  return level === "DEGRADED" || level === "OFFLINE_ONLY";
}

/**
 * Returns true if re-authentication is required.
 */
export function requiresReauth(level: AuthConfidenceLevel): boolean {
  return level === "INVALID";
}

/**
 * Derive confidence level from session state.
 */
export function deriveConfidence(opts: {
  hasSession: boolean;
  jwtFresh: boolean;          // token not expired
  jwtNearExpiry: boolean;     // < 5 min remaining
  lastRefreshSucceeded: boolean;
  isOnline: boolean;
  refreshFailures: number;
}): AuthConfidenceLevel {
  if (!opts.hasSession) return "INVALID";
  if (!opts.isOnline) return "OFFLINE_ONLY";
  if (!opts.jwtFresh) return "RECOVERY_REQUIRED";
  if (opts.refreshFailures >= 2) return "DEGRADED";
  if (opts.jwtNearExpiry && !opts.lastRefreshSucceeded) return "DEGRADED";
  return "RECOVERED";
}
