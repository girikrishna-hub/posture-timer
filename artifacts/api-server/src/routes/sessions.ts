import { Router, type IRouter } from "express";
import { eq, desc, and, gte, lte, isNull, isNotNull } from "drizzle-orm";
import { db, sessionsTable } from "@workspace/db";
import {
  StartSessionBody,
  EndSessionParams,
  EndSessionBody,
  ListSessionsQueryParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";

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

router.post("/sessions", requireAuth, async (req, res) => {
  const parse = StartSessionBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request body", details: parse.error.issues });
    return;
  }

  const { mode, startedAt, restType } = parse.data;

  const [session] = await db
    .insert(sessionsTable)
    .values({
      userId: req.userId,
      mode,
      startedAt: startedAt ?? new Date(),
      ...(restType != null ? { restType } : {}),
    })
    .returning();

  res.status(201).json(formatSession(session));
});

router.get("/sessions/export", requireAuth, async (req, res) => {
  const sessions = await db
    .select()
    .from(sessionsTable)
    .where(and(
      eq(sessionsTable.userId, req.userId),
      isNotNull(sessionsTable.endedAt),
    ))
    .orderBy(desc(sessionsTable.startedAt));

  const header = "date,mode,rest_type,started_at,ended_at,duration_minutes\n";
  const rows = sessions
    .map((s) => {
      const date = s.startedAt.toISOString().split("T")[0] ?? "";
      const restType = s.restType ?? "";
      const endedAt = s.endedAt ? s.endedAt.toISOString() : "";
      const durationMinutes = s.durationSeconds
        ? (s.durationSeconds / 60).toFixed(2)
        : "";
      return `${date},${s.mode},${restType},${s.startedAt.toISOString()},${endedAt},${durationMinutes}`;
    })
    .join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="sit-stand-sessions.csv"',
  );
  res.send(header + rows);
});

router.get("/sessions/active", requireAuth, async (req, res) => {
  const [active] = await db
    .select()
    .from(sessionsTable)
    .where(and(
      eq(sessionsTable.userId, req.userId),
      isNull(sessionsTable.endedAt),
    ))
    .orderBy(desc(sessionsTable.startedAt))
    .limit(1);

  res.json({ session: active ? formatSession(active) : null });
});

router.get("/sessions", requireAuth, async (req, res) => {
  const rawQuery = {
    ...req.query,
    from:
      typeof req.query.from === "string" ? new Date(req.query.from) : undefined,
    to:
      typeof req.query.to === "string" ? new Date(req.query.to) : undefined,
  };
  const queryResult = ListSessionsQueryParams.safeParse(rawQuery);
  if (!queryResult.success) {
    res.status(400).json({ error: "Invalid query parameters", details: queryResult.error.issues });
    return;
  }
  const { from, to, limit, offset } = queryResult.data;

  const conditions: ReturnType<typeof eq>[] = [eq(sessionsTable.userId, req.userId)];
  if (from) conditions.push(gte(sessionsTable.startedAt, from));
  if (to) {
    const toEnd = new Date(to);
    toEnd.setHours(23, 59, 59, 999);
    conditions.push(lte(sessionsTable.startedAt, toEnd));
  }

  const sessions = await db
    .select()
    .from(sessionsTable)
    .where(and(...conditions))
    .orderBy(desc(sessionsTable.startedAt))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select()
    .from(sessionsTable)
    .where(and(...conditions));

  res.json({
    sessions: sessions.map(formatSession),
    total: countResult.length,
  });
});

router.patch("/sessions/:id", requireAuth, async (req, res) => {
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
    .where(and(eq(sessionsTable.id, id), eq(sessionsTable.userId, req.userId)))
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
    .where(and(eq(sessionsTable.id, id), eq(sessionsTable.userId, req.userId)))
    .returning();

  res.json(formatSession(updated));
});

export default router;
