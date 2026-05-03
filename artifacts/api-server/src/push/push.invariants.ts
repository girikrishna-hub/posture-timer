import { hasActivePostureTimer } from "../services/pushScheduler";
import { sessionRepository } from "../sessions/session.repository";
import { logger } from "../lib/logger";

const MAX_HEAL_ATTEMPTS = 2;

// ─── Self-heal failure counter ───────────────────────────────────────────────
// Incremented each time a mismatch persists after MAX_HEAL_ATTEMPTS retries.
// Never reset — lifetime count since last server start. Exposed via the debug
// endpoint so operators can detect persistent inconsistencies without grepping logs.

let failedSelfHealCount = 0;

/** Returns the number of self-heal hard failures since process start. */
export function getSelfHealFailureCount(): number {
  return failedSelfHealCount;
}

/**
 * Self-healing consistency check with loop guard.
 *
 * Compares in-process timer state against the active session stored in the DB.
 * When a mismatch is found it logs an ERROR and calls `healFn` to converge.
 * Re-checks after healing (up to MAX_HEAL_ATTEMPTS times) to confirm the fix
 * took effect. Stops and logs a HARD ERROR if the state still diverges after
 * all retries — prevents infinite healing loops.
 *
 * Never throws. The goal is convergence, not crash.
 *
 * Consistent states:
 *   • No active session          → no timer
 *   • sitting / standing session → exactly one timer
 *   • resting / walking session  → no timer
 *
 * @param healFn  Injected by the caller to avoid circular module imports.
 * @param attempt Current retry depth (callers should omit; defaults to 0).
 */
export async function ensureSingleActiveTimer(
  userId: string,
  healFn: (userId: string) => Promise<void>,
  attempt = 0,
): Promise<void> {
  const [hasTimer, activeSession] = await Promise.all([
    Promise.resolve(hasActivePostureTimer(userId)),
    sessionRepository.findActiveSession(userId),
  ]);

  const mode = activeSession?.mode ?? null;
  const shouldHaveTimer = mode === "sitting" || mode === "standing";

  if (hasTimer === shouldHaveTimer) return; // consistent — nothing to do

  // ── Mismatch detected ────────────────────────────────────────────────────
  const direction = hasTimer
    ? "timer active but no sitting/standing session"
    : "sitting/standing session but no timer";

  if (attempt >= MAX_HEAL_ATTEMPTS) {
    failedSelfHealCount++;
    logger.error(
      {
        event: "self.heal.failed",
        userId,
        activeSessionMode: mode,
        hasTimer,
        shouldHaveTimer,
        attempts: attempt,
        direction,
        action: "requires_manual_reconciliation",
        lifetimeFailureCount: failedSelfHealCount,
      },
      "push.invariants: self-heal HARD FAILURE — mismatch persists after max retries; giving up to avoid infinite loop",
    );
    return;
  }

  logger.error(
    {
      event: "self.heal.mismatch",
      userId,
      activeSessionMode: mode,
      hasTimer,
      shouldHaveTimer,
      attempt,
      direction,
    },
    `push.invariants: mismatch detected (attempt ${attempt + 1}/${MAX_HEAL_ATTEMPTS}) — healing`,
  );

  try {
    await healFn(userId);
  } catch (err) {
    logger.error(
      { err, userId, attempt },
      "push.invariants: healFn threw during self-heal — stopping",
    );
    return;
  }

  // Re-check: verify the heal actually converged.
  await ensureSingleActiveTimer(userId, healFn, attempt + 1);

  logger.info(
    { event: "self.heal.success", userId, activeSessionMode: mode, attempt },
    "push.invariants: self-healed — timer state converged to session state",
  );
}
