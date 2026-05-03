import { hasActivePostureTimer } from "../services/pushScheduler";
import { sessionRepository } from "../sessions/session.repository";
import { logger } from "../lib/logger";

/**
 * Soft invariant check: logs an error when the posture timer state and the
 * active session state are inconsistent. Does NOT throw — violations are
 * surfaced as structured error logs so the system stays alive.
 *
 * Consistent states:
 *   • No active session          → no timer
 *   • sitting / standing session → exactly one timer
 *   • resting / walking session  → no timer  (these modes don't use push)
 */
export async function assertSingleActiveTimer(userId: string): Promise<void> {
  const [hasTimer, activeSession] = await Promise.all([
    Promise.resolve(hasActivePostureTimer(userId)),
    sessionRepository.findActiveSession(userId),
  ]);

  const mode = activeSession?.mode ?? null;
  const shouldHaveTimer =
    mode === "sitting" || mode === "standing";

  if (hasTimer && !shouldHaveTimer) {
    logger.error(
      { userId, activeSessionMode: mode },
      "push.invariants: posture timer is active but no sitting/standing session exists — mismatch detected",
    );
    return;
  }

  if (!hasTimer && shouldHaveTimer) {
    logger.error(
      { userId, activeSessionMode: mode },
      "push.invariants: sitting/standing session is active but no posture timer exists — mismatch detected",
    );
  }
}
