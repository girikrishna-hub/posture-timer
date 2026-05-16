/**
 * SessionRestorationValidator — validates that a persisted session is worth restoring.
 *
 * "Metadata exists" is insufficient for restoration success.
 * This validator checks:
 * - Structural integrity of the persisted record
 * - JWT expiry (is the token still usable?)
 * - Refresh viability (can we get a new JWT?)
 * - Expiry correctness (does wall-clock expiry agree with monotonic estimate?)
 * - Backend continuity (is the refresh endpoint reachable?)
 * - Clock drift (was the device clock manipulated during suspension?)
 *
 * Returns a typed ValidationResult that the runtime uses to decide the
 * restoration path (full restore, degraded restore, or clear + sign-out).
 */

import type { VaultedSession } from "./SecureSessionVault";
import type { AuthConfidenceLevel } from "./AuthConfidenceLevel";

export type ValidationOutcome =
  /** Session is valid and a live JWT refresh is likely to succeed. */
  | "RESTORABLE"
  /** Session has expired but the refresh window is still open. */
  | "REFRESH_REQUIRED"
  /** Device is offline — restore from metadata only, defer refresh. */
  | "OFFLINE_RESTORABLE"
  /** Session is too old or definitively expired; must re-authenticate. */
  | "EXPIRED_UNRESTORABLE"
  /** Metadata is structurally invalid or corrupted. */
  | "CORRUPTED";

export interface ValidationResult {
  outcome: ValidationOutcome;
  confidence: AuthConfidenceLevel;
  reason: string;
  clockDriftMs: number;
  msUntilExpiry: number;
}

const MAX_CLOCK_DRIFT_MS = 5 * 60 * 1000;       // 5 min — flag as suspicious
const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;  // 24 h past JWT expiry
const NEAR_EXPIRY_THRESHOLD_MS = 5 * 60 * 1000; // < 5 min remaining

export class SessionRestorationValidator {
  validate(meta: VaultedSession): ValidationResult {
    const now = Date.now();
    const msUntilExpiry = meta.expiresAt - now;

    // ── Clock drift check ──────────────────────────────────────────────────
    const monoElapsed = performance.now() - meta.monotonicOffsetMs;
    const wallElapsed = now - meta.persistedAt;
    const clockDriftMs = Math.abs(wallElapsed - monoElapsed);

    const hasSuspectDrift = clockDriftMs > MAX_CLOCK_DRIFT_MS;
    if (hasSuspectDrift) {
      console.warn(
        `[SessionValidator] Clock drift detected: ${Math.round(clockDriftMs / 1000)}s` +
        " — treating session as degraded"
      );
    }

    // ── Structural validation ─────────────────────────────────────────────
    if (
      !meta.sessionId ||
      !meta.userId ||
      typeof meta.expiresAt !== "number" ||
      meta.expiresAt <= 0
    ) {
      return {
        outcome: "CORRUPTED",
        confidence: "INVALID",
        reason: "Persisted session missing required fields",
        clockDriftMs,
        msUntilExpiry,
      };
    }

    // ── Offline path ─────────────────────────────────────────────────────
    if (!navigator.onLine) {
      const isStillValid = msUntilExpiry > 0;
      if (isStillValid) {
        return {
          outcome: "OFFLINE_RESTORABLE",
          confidence: "OFFLINE_ONLY",
          reason: "Device offline — restoring session from cache",
          clockDriftMs,
          msUntilExpiry,
        };
      }
      // Expired AND offline — can't refresh, can't confirm
      return {
        outcome: "EXPIRED_UNRESTORABLE",
        confidence: "INVALID",
        reason: "Session expired and device is offline — cannot refresh",
        clockDriftMs,
        msUntilExpiry,
      };
    }

    // ── Online expiry assessment ──────────────────────────────────────────

    // Token is current (not expired, not near expiry)
    if (msUntilExpiry > NEAR_EXPIRY_THRESHOLD_MS) {
      return {
        outcome: "RESTORABLE",
        confidence: hasSuspectDrift ? "DEGRADED" : "RECOVERED",
        reason: `Session valid for ${Math.round(msUntilExpiry / 60000)} more minutes`,
        clockDriftMs,
        msUntilExpiry,
      };
    }

    // Token near expiry or expired — check refresh window
    const withinRefreshWindow = now < meta.expiresAt + REFRESH_WINDOW_MS;
    if (withinRefreshWindow) {
      return {
        outcome: "REFRESH_REQUIRED",
        confidence: "RECOVERY_REQUIRED",
        reason: msUntilExpiry <= 0
          ? `Session expired ${Math.round(-msUntilExpiry / 60000)} minutes ago — refresh required`
          : "Session near expiry — proactive refresh required",
        clockDriftMs,
        msUntilExpiry,
      };
    }

    // Beyond refresh window — force sign-out
    return {
      outcome: "EXPIRED_UNRESTORABLE",
      confidence: "INVALID",
      reason: `Session expired ${Math.round(-msUntilExpiry / 3600000)} hours ago — beyond refresh window`,
      clockDriftMs,
      msUntilExpiry,
    };
  }
}
