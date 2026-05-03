import { hasActivePostureTimer } from "../services/pushScheduler";
import { sessionRepository } from "../sessions/session.repository";
import { logger } from "../lib/logger";

/**
 * Self-healing consistency check.
 *
 * Compares in-process timer state against the active session stored in the DB.
 * When a mismatch is found it logs an ERROR and then calls `healFn` to bring
 * the system back to a consistent state. Never throws — the goal is convergence,
 * not crash.
 *
 * Consistent states:
 *   • No active session          → no timer
 *   • sitting / standing session → exactly one timer
 *   • resting / walking session  → no timer
 *
 * @param healFn  Injected by the caller (typically postureOrchestrator.syncTimerWithSession)
 *                to avoid a circular module import between orchestrator ↔ invariants.
 */
export async function ensureSingleActiveTimer(
  userId: string,
  healFn: (userId: string) => Promise<void>,
): Promise<void> {
  const [hasTimer, activeSession] = await Promise.all([
    Promise.resolve(hasActivePostureTimer(userId)),
    sessionRepository.findActiveSession(userId),
  ]);

  const mode = activeSession?.mode ?? null;
  const shouldHaveTimer = mode === "sitting" || mode === "standing";

  if (hasTimer === shouldHaveTimer) return; // consistent — nothing to do

  if (hasTimer && !shouldHaveTimer) {
    logger.error(
      { userId, activeSessionMode: mode },
      "push.invariants: posture timer is active but no sitting/standing session exists — mismatch detected; healing",
    );
  } else {
    logger.error(
      { userId, activeSessionMode: mode },
      "push.invariants: sitting/standing session is active but no posture timer exists — mismatch detected; healing",
    );
  }

  try {
    await healFn(userId);
    logger.info(
      { userId, activeSessionMode: mode },
      "push.invariants: self-healed — timer state converged to session state",
    );
  } catch (err) {
    logger.error(
      { err, userId },
      "push.invariants: self-heal attempt failed",
    );
  }
}
