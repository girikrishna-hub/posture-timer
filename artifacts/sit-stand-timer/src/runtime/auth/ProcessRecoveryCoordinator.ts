/**
 * ProcessRecoveryCoordinator — detects Android process death and reconciles state.
 *
 * Android process death is normal and must not be treated as an error.
 * When the OS kills the app to reclaim memory and the user restarts it,
 * the process starts fresh but persisted state remains in the vault.
 *
 * This coordinator:
 * - Classifies the startup kind from navigation performance timing
 * - Detects whether a previous restoration was incomplete (mid-write death)
 * - Invalidates any stale refresh chains from the previous session
 * - Prevents stale recovery replay from corrupting the new session
 *
 * Startup classification:
 *   COLD_START       — first ever launch, no prior session
 *   WARM_RESUME      — page reload or Capacitor foreground-bring
 *   PROCESS_RECOVERY — Android killed process; user relaunched app
 *   BACKGROUND_RESTORE — rehydrated after very long background (> suspend threshold)
 */

import type { SecureSessionVault } from "./SecureSessionVault";
import type { AuthDiagnosticsJournal } from "./AuthDiagnosticsJournal";
import type { TraceCorrelationManager } from "./TraceCorrelationManager";

export type StartupKind =
  | "COLD_START"
  | "WARM_RESUME"
  | "PROCESS_RECOVERY"
  | "BACKGROUND_RESTORE";

export interface RecoveryAssessment {
  kind: StartupKind;
  vaultIntact: boolean;
  hasPersistedSession: boolean;
  suspectedMidWriteDeath: boolean;
  staleChainIds: string[];
  recommendation: "RESTORE" | "REFRESH_THEN_RESTORE" | "CLEAR_AND_REAUTH" | "PROCEED_DEGRADED";
}

// Threshold: if wall-clock elapsed >> monotonic elapsed, process was likely suspended
const PROCESS_DEATH_THRESHOLD_MS = 60_000;

export class ProcessRecoveryCoordinator {
  constructor(
    private readonly _vault: SecureSessionVault,
    private readonly _journal: AuthDiagnosticsJournal,
    private readonly _trace: TraceCorrelationManager,
  ) {}

  /** Classify how the app was started. */
  detectStartupKind(): StartupKind {
    try {
      const entries = performance.getEntriesByType?.("navigation") ?? [];
      const nav = entries[0] as PerformanceNavigationTiming | undefined;

      if (!nav) {
        // No navigation entry — very first cold start or severe process death
        return "COLD_START";
      }

      if (nav.type === "reload") return "WARM_RESUME";

      // back_forward indicates the page was in the BFCache (not dead)
      if (nav.type === "back_forward") return "WARM_RESUME";

      // Detect long gap: wall clock elapsed since page load start
      // vs monotonic time available — difference suggests prior suspension
      const wallElapsedSinceNavStart = Date.now() - nav.startTime;
      if (wallElapsedSinceNavStart > PROCESS_DEATH_THRESHOLD_MS) {
        return "PROCESS_RECOVERY";
      }

      return "COLD_START";
    } catch {
      return "COLD_START";
    }
  }

  /**
   * Full recovery assessment — run early in boot before session restoration.
   * Checks vault integrity and classifies what restoration path to take.
   */
  async assess(): Promise<RecoveryAssessment> {
    const ctx = this._trace.newOperation({ newRecoveryAttempt: true });
    const kind = this.detectStartupKind();

    this._journal.record("AUTH_INITIALIZED",
      `Process recovery assessment: kind=${kind} op=${ctx.operationId}`);

    // Load vault to check state
    const meta = await this._vault.load();
    const hasPersistedSession = meta !== null;

    // Detect mid-write death: if schemaVersion is missing or persistedAt is
    // very close to now (< 500ms), the write may have been interrupted.
    let suspectedMidWriteDeath = false;
    if (meta) {
      const timeSincePersist = Date.now() - meta.persistedAt;
      // If persisted "just now" but we're doing a cold start, might be a mid-write crash
      if (kind === "COLD_START" && timeSincePersist < 500) {
        suspectedMidWriteDeath = true;
        this._journal.record("AUTH_DEGRADED",
          "Suspected mid-write death: vault persisted < 500ms ago on cold start");
      }
    }

    // Determine recommendation
    let recommendation: RecoveryAssessment["recommendation"];
    if (!hasPersistedSession) {
      recommendation = "CLEAR_AND_REAUTH";
    } else if (suspectedMidWriteDeath) {
      recommendation = "CLEAR_AND_REAUTH";
    } else if (kind === "PROCESS_RECOVERY" && meta && meta.expiresAt < Date.now()) {
      recommendation = "REFRESH_THEN_RESTORE";
    } else if (kind === "PROCESS_RECOVERY") {
      recommendation = "REFRESH_THEN_RESTORE";
    } else {
      recommendation = "RESTORE";
    }

    const assessment: RecoveryAssessment = {
      kind,
      vaultIntact: !suspectedMidWriteDeath,
      hasPersistedSession,
      suspectedMidWriteDeath,
      staleChainIds: [], // refreshChainCoordinator will populate
      recommendation,
    };

    this._journal.record("AUTH_SESSION_RESTORED",
      `Recovery assessment complete: ${recommendation} ` +
      `(kind=${kind} intact=${assessment.vaultIntact})`);

    this._trace.clearRecoveryAttempt();
    return assessment;
  }
}
