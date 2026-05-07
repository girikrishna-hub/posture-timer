import { Router, type IRouter } from "express";
import { eq, gte, lte, and, isNotNull } from "drizzle-orm";
import { db, sessionsTable, settingsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function toDateString(d: Date): string {
  return d.toISOString().split("T")[0];
}

async function getSettings(userId: string) {
  const [s] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId))
    .limit(1);
  return s ?? {
    id: 0,
    userId,
    dailyStandingGoalMinutes: 120,
    sittingAlertMinutes: 45,
    standingMinMinutes: 10,
    standingMaxMinutes: 15,
    reminderIntervalMinutes: 1,
    remindersCount: 3,
    autoDetectWalking: false,
  };
}

function getSessionMinutes(
  sessions: typeof sessionsTable.$inferSelect[],
  mode: "sitting" | "standing" | "resting" | "walking" | "workout",
): number {
  return sessions
    .filter((s) => s.mode === mode)
    .reduce((sum, s) => {
      const dur = s.durationSeconds ?? 0;
      return sum + Math.round(dur / 60);
    }, 0);
}

async function computeStreak(userId: string, goalMinutes: number): Promise<number> {
  const today = new Date();
  let streak = 0;
  let checkDate = new Date(today);

  for (let i = 0; i < 365; i++) {
    const dayStart = startOfDay(checkDate);
    const dayEnd = endOfDay(checkDate);

    const daySessions = await db
      .select()
      .from(sessionsTable)
      .where(
        and(
          eq(sessionsTable.userId, userId),
          gte(sessionsTable.startedAt, dayStart),
          lte(sessionsTable.startedAt, dayEnd),
          isNotNull(sessionsTable.endedAt),
        ),
      );

    const standingMinutes = getSessionMinutes(daySessions, "standing");

    if (standingMinutes >= goalMinutes) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else if (i === 0) {
      checkDate.setDate(checkDate.getDate() - 1);
      continue;
    } else {
      break;
    }
  }

  return streak;
}

router.get("/stats/today", requireAuth, async (req, res) => {
  const now = new Date();
  const dayStart = startOfDay(now);
  const dayEnd = endOfDay(now);

  const settings = await getSettings(req.userId);

  const sessions = await db
    .select()
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.userId, req.userId),
        gte(sessionsTable.startedAt, dayStart),
        lte(sessionsTable.startedAt, dayEnd),
      ),
    );

  const completedSessions = sessions.filter((s) => s.endedAt !== null);

  const sittingMinutes  = getSessionMinutes(completedSessions, "sitting");
  const standingMinutes = getSessionMinutes(completedSessions, "standing");
  const walkingMinutes  = getSessionMinutes(completedSessions, "walking");
  const workoutMinutes  = getSessionMinutes(completedSessions, "workout");
  const restingMinutes  = getSessionMinutes(completedSessions, "resting");
  const activeMinutes   = sittingMinutes + standingMinutes + walkingMinutes + workoutMinutes;
  const goalMinutes     = settings.dailyStandingGoalMinutes;
  const goalProgressPercent =
    goalMinutes > 0
      ? Math.min(100, Math.round((standingMinutes / goalMinutes) * 100))
      : 0;

  const currentStreak = await computeStreak(req.userId, goalMinutes);

  res.json({
    date: toDateString(now),
    sittingMinutes,
    standingMinutes,
    walkingMinutes,
    workoutMinutes,
    restingMinutes,
    activeMinutes,
    goalMinutes,
    goalProgressPercent,
    sessionCount: completedSessions.length,
    currentStreak,
  });
});

router.get("/stats/weekly", requireAuth, async (req, res) => {
  const settings  = await getSettings(req.userId);
  const goalMinutes = settings.dailyStandingGoalMinutes;
  const today = new Date();

  const days = [];
  let weeklyStandingMinutes = 0;

  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const dayStart = startOfDay(date);
    const dayEnd   = endOfDay(date);

    const daySessions = await db
      .select()
      .from(sessionsTable)
      .where(
        and(
          eq(sessionsTable.userId, req.userId),
          gte(sessionsTable.startedAt, dayStart),
          lte(sessionsTable.startedAt, dayEnd),
          isNotNull(sessionsTable.endedAt),
        ),
      );

    const sittingMinutes  = getSessionMinutes(daySessions, "sitting");
    const standingMinutes = getSessionMinutes(daySessions, "standing");
    const walkingMinutes  = getSessionMinutes(daySessions, "walking");
    const workoutMinutes  = getSessionMinutes(daySessions, "workout");
    const restingMinutes  = getSessionMinutes(daySessions, "resting");
    const activeMinutes   = sittingMinutes + standingMinutes + walkingMinutes + workoutMinutes;
    const goalProgressPercent =
      goalMinutes > 0
        ? Math.min(100, Math.round((standingMinutes / goalMinutes) * 100))
        : 0;

    weeklyStandingMinutes += standingMinutes;

    days.push({
      date: toDateString(date),
      sittingMinutes,
      standingMinutes,
      walkingMinutes,
      workoutMinutes,
      restingMinutes,
      activeMinutes,
      goalProgressPercent,
    });
  }

  const currentStreak = await computeStreak(req.userId, goalMinutes);

  res.json({
    days,
    weeklyStandingMinutes,
    weeklyGoalMinutes: goalMinutes * 7,
    currentStreak,
  });
});

export default router;
