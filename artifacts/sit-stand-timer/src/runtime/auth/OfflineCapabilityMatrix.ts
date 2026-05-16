/**
 * OfflineCapabilityMatrix — policy-driven table of what works at each auth confidence level.
 *
 * Avoids implicit offline assumptions by making the policy explicit and queryable.
 * Consumers call capabilityFor(confidence) to get a typed policy object, then
 * use the boolean fields to gate functionality.
 *
 * Rationale for each level:
 *
 * VERIFIED — fresh JWT, backend confirmed. Everything available.
 * RECOVERED — session restored, JWT fresh. Everything available.
 * DEGRADED — JWT stale or refresh failed. Local-only. No sync/cloud.
 * OFFLINE_ONLY — device offline, session cached. Local read-only. No mutations.
 * RECOVERY_REQUIRED — JWT near/past expiry, refresh in progress. Conservative.
 * INVALID — no valid session. Auth screen only.
 */

import type { AuthConfidenceLevel } from "./AuthConfidenceLevel";

export interface OfflineCapabilities {
  /** Local reminder/alarm scheduling */
  localReminders: boolean;
  /** Read cached settings/preferences from last successful sync */
  cachedPreferences: boolean;
  /** Queue analytics events for later sync */
  analyticsQueueing: boolean;
  /** Read cached session data / dashboard */
  cachedDataRead: boolean;
  /** Sync session data to backend */
  syncOperations: boolean;
  /** Edit account settings (name, email, password) */
  accountEditing: boolean;
  /** Access premium/subscription entitlements */
  premiumEntitlement: boolean;
  /** Start a new session (sit/stand/walk/workout) */
  startNewSession: boolean;
  /** End/modify an existing session */
  modifySession: boolean;
}

const MATRIX: Record<AuthConfidenceLevel, OfflineCapabilities> = {
  VERIFIED: {
    localReminders:     true,
    cachedPreferences:  true,
    analyticsQueueing:  true,
    cachedDataRead:     true,
    syncOperations:     true,
    accountEditing:     true,
    premiumEntitlement: true,
    startNewSession:    true,
    modifySession:      true,
  },
  RECOVERED: {
    localReminders:     true,
    cachedPreferences:  true,
    analyticsQueueing:  true,
    cachedDataRead:     true,
    syncOperations:     true,
    accountEditing:     true,
    premiumEntitlement: true,
    startNewSession:    true,
    modifySession:      true,
  },
  DEGRADED: {
    localReminders:     true,
    cachedPreferences:  true,
    analyticsQueueing:  true,
    cachedDataRead:     true,
    syncOperations:     false,   // backend unreachable or JWT stale
    accountEditing:     false,
    premiumEntitlement: true,    // last known entitlement still valid
    startNewSession:    true,    // can track locally
    modifySession:      true,
  },
  OFFLINE_ONLY: {
    localReminders:     true,
    cachedPreferences:  true,
    analyticsQueueing:  true,    // queue, don't send
    cachedDataRead:     true,
    syncOperations:     false,
    accountEditing:     false,
    premiumEntitlement: true,    // cached entitlement
    startNewSession:    true,
    modifySession:      true,
  },
  RECOVERY_REQUIRED: {
    localReminders:     true,
    cachedPreferences:  true,
    analyticsQueueing:  true,
    cachedDataRead:     true,
    syncOperations:     false,   // don't attempt sync with near-expired JWT
    accountEditing:     false,
    premiumEntitlement: true,
    startNewSession:    true,
    modifySession:      true,
  },
  INVALID: {
    localReminders:     false,
    cachedPreferences:  false,
    analyticsQueueing:  false,
    cachedDataRead:     false,
    syncOperations:     false,
    accountEditing:     false,
    premiumEntitlement: false,
    startNewSession:    false,
    modifySession:      false,
  },
};

/**
 * Get the capability set for the current auth confidence level.
 */
export function capabilityFor(confidence: AuthConfidenceLevel): OfflineCapabilities {
  return { ...MATRIX[confidence] };
}

/**
 * Human-readable summary of the current capability set.
 */
export function capabilitySummary(confidence: AuthConfidenceLevel): string {
  const caps = MATRIX[confidence];
  const enabled = Object.entries(caps)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const disabled = Object.entries(caps)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return `${confidence}: ${enabled.length} enabled, ${disabled.length} disabled` +
    (disabled.length > 0 ? ` (blocked: ${disabled.join(", ")})` : "");
}
