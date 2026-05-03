import { db, sessionsTable, type Session } from "@workspace/db";
import { eq, and, isNull, isNotNull, desc, gte, lte, type SQL } from "drizzle-orm";

export interface NewSessionData {
  userId: string;
  mode: "sitting" | "standing" | "resting" | "walking";
  startedAt: Date;
  restType?: "nap" | "sleep" | null;
}

export interface EndSessionData {
  endedAt: Date;
  durationSeconds: number;
  restType?: "nap" | "sleep" | null;
}

export const sessionRepository = {
  async findActiveSession(userId: string): Promise<Session | null> {
    const [session] = await db
      .select()
      .from(sessionsTable)
      .where(and(eq(sessionsTable.userId, userId), isNull(sessionsTable.endedAt)))
      .orderBy(desc(sessionsTable.startedAt))
      .limit(1);
    return session ?? null;
  },

  async findAllOpenSessions(userId: string): Promise<Session[]> {
    return db
      .select()
      .from(sessionsTable)
      .where(and(eq(sessionsTable.userId, userId), isNull(sessionsTable.endedAt)));
  },

  async createSession(data: NewSessionData): Promise<Session> {
    const [session] = await db
      .insert(sessionsTable)
      .values({
        userId: data.userId,
        mode: data.mode,
        startedAt: data.startedAt,
        ...(data.restType != null ? { restType: data.restType } : {}),
      })
      .returning();
    return session;
  },

  async endSession(
    sessionId: number,
    userId: string,
    data: EndSessionData,
  ): Promise<Session | null> {
    const [updated] = await db
      .update(sessionsTable)
      .set({
        endedAt: data.endedAt,
        durationSeconds: data.durationSeconds,
        ...(data.restType !== undefined ? { restType: data.restType } : {}),
      })
      .where(and(eq(sessionsTable.id, sessionId), eq(sessionsTable.userId, userId)))
      .returning();
    return updated ?? null;
  },

  async findSessionById(sessionId: number): Promise<Session | null> {
    const [session] = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .limit(1);
    return session ?? null;
  },

  async findSessionsByUser(
    userId: string,
    opts: { from?: Date; to?: Date; limit: number; offset: number },
  ): Promise<{ sessions: Session[]; total: number }> {
    const conditions: SQL[] = [eq(sessionsTable.userId, userId)];
    if (opts.from) conditions.push(gte(sessionsTable.startedAt, opts.from));
    if (opts.to) {
      const toEnd = new Date(opts.to);
      toEnd.setHours(23, 59, 59, 999);
      conditions.push(lte(sessionsTable.startedAt, toEnd));
    }

    const [sessions, allMatching] = await Promise.all([
      db
        .select()
        .from(sessionsTable)
        .where(and(...conditions))
        .orderBy(desc(sessionsTable.startedAt))
        .limit(opts.limit)
        .offset(opts.offset),
      db
        .select({ id: sessionsTable.id })
        .from(sessionsTable)
        .where(and(...conditions)),
    ]);

    return { sessions, total: allMatching.length };
  },

  async findAllCompletedByUser(userId: string): Promise<Session[]> {
    return db
      .select()
      .from(sessionsTable)
      .where(and(eq(sessionsTable.userId, userId), isNotNull(sessionsTable.endedAt)))
      .orderBy(desc(sessionsTable.startedAt));
  },
};
