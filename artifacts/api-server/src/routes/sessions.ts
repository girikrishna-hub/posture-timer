import { Router, type IRouter } from "express";
import { eq, desc, and, gte, lte, isNull } from "drizzle-orm";
import { db, sessionsTable } from "@workspace/db";
import {
  StartSessionBody,
  EndSessionParams,
  EndSessionBody,
} from "@workspace/api-zod";

function parseQueryDate(val: unknown): Date | undefined {
  if (!val || typeof val !== "string") return undefined;
  const d = new Date(val);
  return isNaN(d.getTime()) ? undefined : d;
}

function parseQueryInt(val: unknown, fallback: number): number {
  if (!val || typeof val !== "string") return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

const router: IRouter = Router();

function classifyRest(
  startedAt: Date,
  endedAt: Date,
): "nap" | "sleep" | null {
  const durationMs = endedAt.getTime() - startedAt.getTime();
  const durationHours = durationMs / (1000 * 60 * 60);
  const startHour = startedAt.getHours();
  const endHour = endedAt.getHours();

  const isNighttime = startHour >= 21 || startHour < 8 || endHour >= 21 || endHour < 8;
  if (durationHours >= 3 || isNighttime) return "sleep";
  if (startHour >= 11 && startHour < 18) return "nap";
  return null;
}

function formatSession(s: typeof sessionsTable.$inferSelect) {
  return {
    id: s.id,
    mode: s.mode,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
    durationSeconds: s.durationSeconds,
    restType: s.restType,
  };
}

router.post("/sessions", async (req, res) => {
  const parse = StartSessionBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request body", details: parse.error.issues });
    return;
  }

  const { mode, startedAt } = parse.data;

  const [session] = await db
    .insert(sessionsTable)
    .values({ mode, startedAt: startedAt ?? new Date() })
    .returning();

  res.status(201).json(formatSession(session));
});

router.get("/sessions/active", async (req, res) => {
  const [active] = await db
    .select()
    .from(sessionsTable)
    .where(isNull(sessionsTable.endedAt))
    .orderBy(desc(sessionsTable.startedAt))
    .limit(1);

  res.json({ session: active ? formatSession(active) : null });
});

router.get("/sessions", async (req, res) => {
  const from = parseQueryDate(req.query.from);
  const to = parseQueryDate(req.query.to);
  const limit = parseQueryInt(req.query.limit, 100);
  const offset = parseQueryInt(req.query.offset, 0);

  const conditions = [];
  if (from) {
    conditions.push(gte(sessionsTable.startedAt, from));
  }
  if (to) {
    const toEnd = new Date(to);
    toEnd.setHours(23, 59, 59, 999);
    conditions.push(lte(sessionsTable.startedAt, toEnd));
  }

  const query = db
    .select()
    .from(sessionsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(sessionsTable.startedAt))
    .limit(limit)
    .offset(offset);

  const sessions = await query;

  const countResult = await db
    .select()
    .from(sessionsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  res.json({
    sessions: sessions.map(formatSession),
    total: countResult.length,
  });
});

router.patch("/sessions/:id", async (req, res) => {
  const paramsResult = EndSessionParams.safeParse(req.params);
  if (!paramsResult.success) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }

  const bodyResult = EndSessionBody.safeParse(req.body ?? {});
  if (!bodyResult.success) {
    res.status(400).json({ error: "Invalid request body", details: bodyResult.error.issues });
    return;
  }
  const providedEndedAt = bodyResult.data.endedAt;

  const { id } = paramsResult.data;

  const [existing] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.id, id))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const endedAt = providedEndedAt ?? new Date();
  const durationSeconds = Math.round(
    (endedAt.getTime() - existing.startedAt.getTime()) / 1000,
  );

  let restType: "nap" | "sleep" | null = existing.restType;
  if (existing.mode === "resting" && !existing.restType) {
    restType = classifyRest(existing.startedAt, endedAt);
  }

  const [updated] = await db
    .update(sessionsTable)
    .set({ endedAt, durationSeconds, restType })
    .where(eq(sessionsTable.id, id))
    .returning();

  res.json(formatSession(updated));
});

export default router;
