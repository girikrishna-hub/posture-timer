import { sessionRepository } from "./session.repository";
import { assertSessionInvariants } from "./session.invariants";
import { logger } from "../lib/logger";
import { postureOrchestrator } from "../orchestrators/posture.orchestrator";
import { assertValidUserId } from "../lib/assertValidUserId";
import type { Session } from "@workspace/db";
import type {
  StartSessionDto,
  EndSessionDto,
  ListSessionsDto,
  SessionDto,
} from "./session.dto";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Classify a completed resting session as a nap or sleep based on duration
 * and time of day. Returns null when neither classification applies.
 */
function classifyRest(startedAt: Date, endedAt: Date): "nap" | "sleep" | null {
  const durationHours =
    (endedAt.getTime() - startedAt.getTime()) / (1000 * 60 * 60);
  const startHour = startedAt.getHours();
  const endHour = endedAt.getHours();

  const isNighttime =
    startHour >= 21 || startHour < 8 || endHour >= 21 || endHour < 8;
  if (durationHours >= 3 || isNighttime) return "sleep";
  if (startHour >= 11 && startHour < 18) return "nap";
  return null;
}

function toDto(session: Session): SessionDto {
  return {
    id: session.id,
    mode: session.mode as SessionDto["mode"],
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt ? session.endedAt.toISOString() : null,
    durationSeconds: session.durationSeconds ?? null,
    restType: (session.restType as SessionDto["restType"]) ?? null,
  };
}

// ─── Service ────────────────────────────────────────────────────────────────

export const sessionService = {
  /**
   * Return the current active (open) session, or null when the user is idle.
   */
  async getActiveSession(userId: string): Promise<SessionDto | null> {
    const session = await sessionRepository.findActiveSession(userId);
    return session ? toDto(session) : null;
  },

  /**
   * Start a new session for the user.
   *
   * Delegates entirely to the posture orchestrator so that the
   * find-orphan → close-orphan → create-session sequence runs inside the
   * per-user lock. Without the lock around the DB writes, concurrent POST
   * /sessions requests can race into the DB and produce overlapping sessions
   * that violate invariant 3.
   */
  async startSession(userId: string, dto: StartSessionDto): Promise<SessionDto> {
    // Hard guard — a real Clerk userId is never empty. If we reach this point
    // with an empty string it means requireAuth was bypassed or misconfigured.
    assertValidUserId(userId);
    return postureOrchestrator.startSession(userId, dto);
  },

  /**
   * End an open session. Validates ownership, computes duration, and
   * classifies rest sessions before persisting.
   */
  async endSession(
    userId: string,
    sessionId: number,
    dto: EndSessionDto,
  ): Promise<SessionDto> {
    // Hard guard — belt-and-suspenders behind requireAuth.
    assertValidUserId(userId);

    const existing = await sessionRepository.findSessionById(sessionId);

    if (!existing || existing.userId !== userId) {
      throw Object.assign(new Error("Session not found"), {
        code: "NOT_FOUND",
      });
    }

    if (existing.endedAt !== null) {
      throw Object.assign(
        new Error(`Session ${sessionId} is already ended (endedAt: ${existing.endedAt.toISOString()})`),
        { code: "ALREADY_ENDED" },
      );
    }

    const endedAt = dto.endedAt ?? new Date();
    const durationSeconds = Math.round(
      (endedAt.getTime() - existing.startedAt.getTime()) / 1000,
    );

    let restType: "nap" | "sleep" | null = existing.restType ?? null;
    if (existing.mode === "resting" && !existing.restType) {
      restType = classifyRest(existing.startedAt, endedAt);
    }

    const updated = await sessionRepository.endSession(sessionId, userId, {
      endedAt,
      durationSeconds,
      restType,
    });

    if (!updated) {
      throw Object.assign(new Error("Session not found"), {
        code: "NOT_FOUND",
      });
    }

    logger.info(
      { userId, sessionId, durationSeconds },
      "session ended",
    );

    await assertSessionInvariants(userId);

    // Cancel the posture timer for the session that just ended.
    await postureOrchestrator.onSessionEnded(userId, toDto(updated));

    return toDto(updated);
  },

  /**
   * List sessions with optional date-range filters and pagination.
   */
  async listSessions(
    userId: string,
    dto: ListSessionsDto,
  ): Promise<{ sessions: SessionDto[]; total: number }> {
    const { sessions, total } = await sessionRepository.findSessionsByUser(
      userId,
      dto,
    );
    return { sessions: sessions.map(toDto), total };
  },

  /**
   * Return all completed sessions as raw DB rows (for CSV export).
   * The controller is responsible for serializing to the desired format.
   */
  async exportSessions(userId: string): Promise<Session[]> {
    return sessionRepository.findAllCompletedByUser(userId);
  },
};
