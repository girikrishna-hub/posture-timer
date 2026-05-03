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

  for (const s of completed) {
    // Invariant 2: endedAt must not precede startedAt
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
  for (let i = 0; i < completed.length; i++) {
    for (let j = i + 1; j < completed.length; j++) {
      const a = completed[i]!;
      const b = completed[j]!;
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
