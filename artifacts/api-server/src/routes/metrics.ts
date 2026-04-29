import { Router, type IRouter } from "express";
import { and, gte, lte, isNotNull, eq } from "drizzle-orm";
import { db, sessionsTable, settingsTable } from "@workspace/db";

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
  return d.toISOString().split("T")[0]!;
}

async function getSettings() {
  const [s] = await db.select().from(settingsTable).limit(1);
  return s ?? {
    id: 0,
    dailyStandingGoalMinutes: 120,
    sittingAlertMinutes: 45,
    standingMinMinutes: 10,
    standingMaxMinutes: 15,
    reminderIntervalMinutes: 1,
    remindersCount: 3,
  };
}

function getMinutes(
  sessions: typeof sessionsTable.$inferSelect[],
  mode: string,
  restType?: string | null,
): number {
  return sessions
    .filter((s) => {
      if (s.mode !== mode) return false;
      if (restType !== undefined) return s.restType === restType;
      return true;
    })
    .reduce((sum, s) => sum + Math.round((s.durationSeconds ?? 0) / 60), 0);
}

function healthScore(standingMinutes: number, goalMinutes: number): number {
  if (goalMinutes === 0) return 0;
  return Math.min(100, Math.round((standingMinutes / goalMinutes) * 100));
}

function healthLabel(score: number): string {
  if (score >= 90) return "Excellent";
  if (score >= 70) return "Great";
  if (score >= 50) return "Good";
  if (score >= 30) return "Fair";
  return "Needs work";
}

async function computeStreakFrom(
  date: Date,
  goalMinutes: number,
): Promise<number> {
  let streak = 0;
  let checkDate = new Date(date);

  for (let i = 0; i < 365; i++) {
    const dayStart = startOfDay(checkDate);
    const dayEnd = endOfDay(checkDate);

    const sessions = await db
      .select()
      .from(sessionsTable)
      .where(
        and(
          gte(sessionsTable.startedAt, dayStart),
          lte(sessionsTable.startedAt, dayEnd),
          isNotNull(sessionsTable.endedAt),
          eq(sessionsTable.mode, "standing"),
        ),
      );

    const standMin = sessions.reduce(
      (sum, s) => sum + Math.round((s.durationSeconds ?? 0) / 60),
      0,
    );

    if (standMin >= goalMinutes) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else if (i === 0) {
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  return streak;
}

async function computeLongestStreak(goalMinutes: number): Promise<number> {
  const sessions = await db
    .select()
    .from(sessionsTable)
    .where(and(isNotNull(sessionsTable.endedAt), eq(sessionsTable.mode, "standing")))
    .orderBy(sessionsTable.startedAt);

  if (sessions.length === 0) return 0;

  const dailyMap = new Map<string, number>();
  for (const s of sessions) {
    const key = toDateString(s.startedAt);
    const existing = dailyMap.get(key) ?? 0;
    dailyMap.set(key, existing + Math.round((s.durationSeconds ?? 0) / 60));
  }

  const dates = Array.from(dailyMap.keys()).sort();
  let longest = 0;
  let current = 0;

  for (let i = 0; i < dates.length; i++) {
    const mins = dailyMap.get(dates[i]!) ?? 0;
    if (mins >= goalMinutes) {
      current++;
      longest = Math.max(longest, current);
    } else {
      const prev = dates[i - 1];
      if (i > 0 && prev) {
        const d1 = new Date(prev);
        const d2 = new Date(dates[i]!);
        const diffDays = Math.round(
          (d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24),
        );
        if (diffDays > 1) current = 0;
        else current = 0;
      } else {
        current = 0;
      }
    }
  }

  return longest;
}

router.get("/metrics/daily", async (req, res) => {
  const { from, to } = req.query;
  if (typeof from !== "string" || typeof to !== "string") {
    res.status(400).json({ error: "from and to query params are required (YYYY-MM-DD)" });
    return;
  }

  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    res.status(400).json({ error: "Invalid date format" });
    return;
  }

  const settings = await getSettings();
  const goalMinutes = settings.dailyStandingGoalMinutes;

  const allSessions = await db
    .select()
    .from(sessionsTable)
    .where(
      and(
        gte(sessionsTable.startedAt, startOfDay(fromDate)),
        lte(sessionsTable.startedAt, endOfDay(toDate)),
        isNotNull(sessionsTable.endedAt),
      ),
    );

  const days: {
    date: string;
    sittingMinutes: number;
    standingMinutes: number;
    napMinutes: number;
    sleepMinutes: number;
    activeMinutes: number;
    goalProgressPercent: number;
    healthScore: number;
  }[] = [];

  const current = new Date(fromDate);
  while (current <= toDate) {
    const dateStr = toDateString(current);
    const daySessions = allSessions.filter(
      (s) => toDateString(s.startedAt) === dateStr,
    );

    const sittingMinutes = getMinutes(daySessions, "sitting");
    const standingMinutes = getMinutes(daySessions, "standing");
    const napMinutes = getMinutes(daySessions, "resting", "nap");
    const sleepMinutes = getMinutes(daySessions, "resting", "sleep");
    const activeMinutes = sittingMinutes + standingMinutes;
    const goalProgressPercent =
      goalMinutes > 0
        ? Math.min(100, Math.round((standingMinutes / goalMinutes) * 100))
        : 0;
    const score = healthScore(standingMinutes, goalMinutes);

    days.push({
      date: dateStr,
      sittingMinutes,
      standingMinutes,
      napMinutes,
      sleepMinutes,
      activeMinutes,
      goalProgressPercent,
      healthScore: score,
    });

    current.setDate(current.getDate() + 1);
  }

  res.json({ days, goalMinutes });
});

router.get("/metrics/summary", async (_req, res) => {
  const settings = await getSettings();
  const goalMinutes = settings.dailyStandingGoalMinutes;

  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);

  const [currentStreak, longest] = await Promise.all([
    computeStreakFrom(today, goalMinutes),
    computeLongestStreak(goalMinutes),
  ]);

  const last7Days: { date: string; standingMinutes: number }[] = [];
  let weeklyTotal = 0;

  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const daySessions = await db
      .select()
      .from(sessionsTable)
      .where(
        and(
          gte(sessionsTable.startedAt, startOfDay(d)),
          lte(sessionsTable.startedAt, endOfDay(d)),
          isNotNull(sessionsTable.endedAt),
          eq(sessionsTable.mode, "standing"),
        ),
      );
    const mins = daySessions.reduce(
      (sum, s) => sum + Math.round((s.durationSeconds ?? 0) / 60),
      0,
    );
    last7Days.push({ date: toDateString(d), standingMinutes: mins });
    weeklyTotal += mins;
  }

  const weeklyAverageStandingMinutes = Math.round(weeklyTotal / 7);

  const bestDay = last7Days.reduce(
    (a, b) => (b.standingMinutes > a.standingMinutes ? b : a),
    last7Days[0]!,
  );
  const worstDay = last7Days.reduce(
    (a, b) => (b.standingMinutes < a.standingMinutes ? b : a),
    last7Days[0]!,
  );

  const weekScore = healthScore(weeklyAverageStandingMinutes, goalMinutes);

  const recentSessions = await db
    .select()
    .from(sessionsTable)
    .where(
      and(
        gte(sessionsTable.startedAt, thirtyDaysAgo),
        isNotNull(sessionsTable.endedAt),
        isNotNull(sessionsTable.durationSeconds),
      ),
    );

  const napSessions = recentSessions.filter((s) => s.restType === "nap");
  const sleepSessions = recentSessions.filter((s) => s.restType === "sleep");

  const avgNapDurationMinutes =
    napSessions.length > 0
      ? Math.round(
          napSessions.reduce(
            (sum, s) => sum + (s.durationSeconds ?? 0),
            0,
          ) /
            napSessions.length /
            60,
        )
      : 0;

  const avgSleepDurationMinutes =
    sleepSessions.length > 0
      ? Math.round(
          sleepSessions.reduce(
            (sum, s) => sum + (s.durationSeconds ?? 0),
            0,
          ) /
            sleepSessions.length /
            60,
        )
      : 0;

  let sleepConsistency: {
    avgSleepStartFormatted: string;
    stddevMinutes: number;
    sampleCount: number;
  } | null = null;

  if (sleepSessions.length >= 2) {
    const startMinutes = sleepSessions.map((s) => {
      const h = s.startedAt.getHours();
      const m = s.startedAt.getMinutes();
      let mins = h * 60 + m;
      if (mins < 240) mins += 1440;
      return mins;
    });

    const avg = startMinutes.reduce((a, b) => a + b, 0) / startMinutes.length;
    const variance =
      startMinutes.reduce((sum, m) => sum + Math.pow(m - avg, 2), 0) /
      startMinutes.length;
    const stddev = Math.round(Math.sqrt(variance));

    const avgHour = Math.floor((avg % 1440) / 60);
    const avgMin = Math.round((avg % 1440) % 60);
    const ampm = avgHour < 12 ? "AM" : "PM";
    const displayHour = avgHour % 12 === 0 ? 12 : avgHour % 12;
    const avgSleepStartFormatted = `${displayHour}:${String(avgMin).padStart(2, "0")} ${ampm}`;

    sleepConsistency = {
      avgSleepStartFormatted,
      stddevMinutes: stddev,
      sampleCount: sleepSessions.length,
    };
  }

  res.json({
    currentStreak,
    longestStreak: longest,
    weeklyAverageStandingMinutes,
    bestDayDate: bestDay?.date ?? null,
    bestDayMinutes: bestDay?.standingMinutes ?? 0,
    worstDayDate: worstDay?.date ?? null,
    worstDayMinutes: worstDay?.standingMinutes ?? 0,
    healthScore: weekScore,
    healthLabel: healthLabel(weekScore),
    sleepConsistency,
    avgNapDurationMinutes,
    avgSleepDurationMinutes,
  });
});

export default router;
