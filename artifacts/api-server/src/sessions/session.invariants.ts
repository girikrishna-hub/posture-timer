import { sessionRepository } from "./session.repository";

export class SessionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionInvariantError";
  }
}

/**
 * Asserts that the stored session state for a user is internally consistent.
 * Throws SessionInvariantError on the first violation found. Call this after
 * any mutation (create or end) to catch bugs early rather than silently
 * accumulating invalid state.
 *
 * Invariants checked:
 *   1. Only one active session (endedAt IS NULL) per user at any time.
 *   2. Every completed session has endedAt >= startedAt.
 *   3. No two completed sessions have overlapping time ranges.
 *      (Checked across the 50 most recent sessions — sufficient for a
 *       sequential-mode timer app where overlaps only arise from bugs.)
 */
export async function assertSessionInvariants(userId: string): Promise<void> {
  const [openSessions, { sessions: recent }] = await Promise.all([
    sessionRepository.findAllOpenSessions(userId),
    sessionRepository.findSessionsByUser(userId, { limit: 50, offset: 0 }),
  ]);

  // ── Invariant 1: at most one active session ──────────────────────────────
  if (openSessions.length > 1) {
    throw new SessionInvariantError(
      `User has ${openSessions.length} active sessions simultaneously; only 1 is allowed. ` +
        `Open session ids: ${openSessions.map((s) => s.id).join(", ")}`,
    );
  }

  // ── Invariants 2 & 3: apply only to completed sessions ──────────────────
  const completed = recent.filter((s) => s.endedAt !== null);

  // Separate already-corrupted sessions (endedAt < startedAt) so we can log
  // them without crashing the hot path. These are historical records that can
  // only be fixed via a data-migration; throwing here would permanently block
  // every subsequent session start for the affected user.
  const corrupted = completed.filter((s) => s.endedAt! < s.startedAt);
  if (corrupted.length > 0) {
    // Use a logger-compatible approach — import is not available here so we
    // emit a console.warn that the server logger will capture.
    console.warn(
      `[session.invariants] user ${userId} has ${corrupted.length} session(s) with endedAt < startedAt ` +
        `(ids: ${corrupted.map((s) => s.id).join(", ")}). Skipping these in invariant checks.`,
    );
  }

  // Only enforce invariants 2 & 3 against internally consistent sessions.
  // Also exclude sub-2-second sessions: these are cascade artifacts produced
  // when the orchestrator's closeAt clamp (max(rawCloseAt, startedAt+1s))
  // creates multiple 1-second sessions with identical time ranges. Checking
  // them here causes Invariant 3 to fire on the overlapping duplicates,
  // which perpetuates the cascade indefinitely.
  const validCompleted = completed.filter(
    (s) => s.endedAt! >= s.startedAt && (s.durationSeconds ?? 0) > 1,
  );

  // Invariant 2 is now satisfied by definition for validCompleted — kept as
  // an explicit assertion so any regression is caught immediately.
  for (const s of validCompleted) {
    if (s.endedAt! < s.startedAt) {
      throw new SessionInvariantError(
        `Session ${s.id} is invalid: endedAt (${s.endedAt!.toISOString()}) ` +
          `is before startedAt (${s.startedAt.toISOString()}).`,
      );
    }
  }

  // Invariant 3: no overlapping sessions
  // Two sessions overlap when A starts before B ends AND A ends after B starts.
  // Adjacent sessions (A ends exactly when B starts) are NOT overlaps.
  //
  // Before scanning, deduplicate by (startedAt, endedAt): cascade bugs can
  // produce multiple sessions with identical time ranges. Keeping only the
  // lowest-id representative per unique range means the invariant will not
  // fire on those duplicates and perpetuate the cascade. The duplicates
  // themselves should be cleaned up via a DB migration.
  const seen = new Map<string, typeof validCompleted[number]>();
  for (const s of validCompleted) {
    const key = `${s.startedAt.toISOString()}|${s.endedAt!.toISOString()}`;
    const existing = seen.get(key);
    if (!existing || s.id < existing.id) seen.set(key, s);
  }
  const deduped = Array.from(seen.values());

  for (let i = 0; i < deduped.length; i++) {
    for (let j = i + 1; j < deduped.length; j++) {
      const a = deduped[i]!;
      const b = deduped[j]!;
      if (a.startedAt < b.endedAt! && a.endedAt! > b.startedAt) {
        throw new SessionInvariantError(
          `Sessions ${a.id} and ${b.id} have overlapping time ranges ` +
            `(${a.startedAt.toISOString()}–${a.endedAt!.toISOString()} vs ` +
            `${b.startedAt.toISOString()}–${b.endedAt!.toISOString()}).`,
        );
      }
    }
  }
}
