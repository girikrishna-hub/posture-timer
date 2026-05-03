import { sessionRepository } from "./session.repository";
import { assertSessionInvariants } from "./session.invariants";
import { logger } from "../lib/logger";
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
   * Design choice — auto-close orphaned sessions:
   *   If an active session already exists when this is called, it is ended
   *   automatically before the new one is created. This is the safest option
   *   because the client always ends the previous session before starting a
   *   new one; a dangling active session therefore signals a network failure
   *   or a server restart that lost the in-flight PATCH. Silently closing it
   *   is preferable to rejecting a valid new session.
   */
  async startSession(userId: string, dto: StartSessionDto): Promise<SessionDto> {
    const existing = await sessionRepository.findActiveSession(userId);

    if (existing) {
      logger.warn(
        { userId, orphanedSessionId: existing.id },
        "startSession: auto-closing orphaned active session before creating new one",
      );
      const closeAt = dto.startedAt ?? new Date();
      const durationSeconds = Math.max(
        0,
        Math.round(
          (closeAt.getTime() - existing.startedAt.getTime()) / 1000,
        ),
      );
      let restType = existing.restType;
      if (existing.mode === "resting" && !existing.restType) {
        restType = classifyRest(existing.startedAt, closeAt);
      }
      await sessionRepository.endSession(existing.id, userId, {
        endedAt: closeAt,
        durationSeconds,
        restType,
      });
    }

    const session = await sessionRepository.createSession({
      userId,
      mode: dto.mode as "sitting" | "standing" | "resting" | "walking",
      startedAt: dto.startedAt ?? new Date(),
      restType: dto.restType,
    });

    logger.info(
      { userId, sessionId: session.id, mode: session.mode },
      "session started",
    );

    await assertSessionInvariants(userId);
    return toDto(session);
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
    const existing = await sessionRepository.findSessionById(sessionId);

    if (!existing || existing.userId !== userId) {
      throw Object.assign(new Error("Session not found"), {
        code: "NOT_FOUND",
      });
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
