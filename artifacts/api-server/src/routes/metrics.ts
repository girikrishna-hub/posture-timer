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

type Settings = {
  id: number;
  dailyStandingGoalMinutes: number;
  sittingAlertMinutes: number;
  standingMinMinutes: number;
  standingMaxMinutes: number;
  reminderIntervalMinutes: number;
  remindersCount: number;
};

async function getSettings(): Promise<Settings> {
  const [s] = await db.select().from(settingsTable).limit(1);
  return (
    s ?? {
      id: 0,
      dailyStandingGoalMinutes: 120,
      sittingAlertMinutes: 45,
      standingMinMinutes: 10,
      standingMaxMinutes: 15,
      reminderIntervalMinutes: 1,
      remindersCount: 3,
    }
  );
}

type SessionRow = typeof sessionsTable.$inferSelect;

function getMinutes(sessions: SessionRow[], mode: string, restType?: string | null): number {
  return sessions
    .filter((s) => {
      if (s.mode !== mode) return false;
      if (restType !== undefined) return s.restType === restType;
      return true;
    })
    .reduce((sum, s) => sum + Math.round((s.durationSeconds ?? 0) / 60), 0);
}

/**
 * Health score (0–100) = standing_component + reminder_component
 *
 *   standing_component  = min(70, round( (standingMinutes / goalMinutes) * 70 ))
 *   reminder_component  = min(30, round( (reminders_acknowledged / reminders_fired) * 30 ))
 *
 * Reminders are derived from sitting sessions:
 *   - reminders_fired        : sitting sessions with duration >= sittingAlertMinutes
 *   - reminders_acknowledged : of those, sessions where the user stopped before all
 *                              reminders were exhausted, i.e. duration <=
 *                              sittingAlertMinutes + reminderIntervalMinutes * remindersCount
 *
 * When no reminders were fired (user never sat long enough to trigger one),
 * the reminder component is awarded full credit (30 points).
 */
function computeHealthScore(
  standingMinutes: number,
  sittingSessions: Pick<SessionRow, "durationSeconds">[],
  settings: Settings,
): number {
  const goalMinutes = settings.dailyStandingGoalMinutes;
  if (goalMinutes === 0) return 0;

  const alertSecs = settings.sittingAlertMinutes * 60;
  const exhaustedSecs =
    (settings.sittingAlertMinutes +
      settings.reminderIntervalMinutes * settings.remindersCount) *
    60;

  const remindersFired = sittingSessions.filter((s) => (s.durationSeconds ?? 0) >= alertSecs);
  const remindersAcknowledged = remindersFired.filter(
    (s) => (s.durationSeconds ?? 0) <= exhaustedSecs,
  );
  const reminderRatio =
    remindersFired.length === 0 ? 1.0 : remindersAcknowledged.length / remindersFired.length;

  const standingScore = Math.min(70, Math.round((standingMinutes / goalMinutes) * 70));
  const reminderScore = Math.min(30, Math.round(reminderRatio * 30));

  return standingScore + reminderScore;
}

function healthLabel(score: number): string {
  if (score >= 90) return "Excellent";
  if (score >= 70) return "Great";
  if (score >= 50) return "Good";
  if (score >= 30) return "Fair";
  return "Needs work";
}

/** Checks whether a day's sessions met the standing goal (full goal attainment). */
function dayMetGoal(
  daySessions: SessionRow[],
  goalMinutes: number,
): boolean {
  const standingMinutes = getMinutes(daySessions, "standing");
  return standingMinutes >= goalMinutes;
}

/** Current streak: count consecutive days (going back from today) that met the full goal. */
async function computeStreakFrom(date: Date, goalMinutes: number): Promise<number> {
  let streak = 0;
  const checkDate = new Date(date);
  checkDate.setHours(0, 0, 0, 0);

  for (let i = 0; i < 365; i++) {
    const dayStart = startOfDay(checkDate);
    const dayEnd = endOfDay(checkDate);

    const daySessions = await db
      .select()
      .from(sessionsTable)
      .where(
        and(
          gte(sessionsTable.startedAt, dayStart),
          lte(sessionsTable.startedAt, dayEnd),
          isNotNull(sessionsTable.endedAt),
        ),
      );

    if (dayMetGoal(daySessions, goalMinutes)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else if (i === 0) {
      // today hasn't met goal yet — look back one more day
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  return streak;
}

/** Longest streak: walk every calendar day from first session date to today. */
async function computeLongestStreak(goalMinutes: number): Promise<number> {
  // Fetch all completed sessions (any mode) ordered chronologically
  const allSessions = await db
    .select()
    .from(sessionsTable)
    .where(isNotNull(sessionsTable.endedAt))
    .orderBy(sessionsTable.startedAt);

  if (allSessions.length === 0) return 0;

  // Group by date
  const byDate = new Map<string, SessionRow[]>();
  for (const s of allSessions) {
    const key = toDateString(s.startedAt);
    const arr = byDate.get(key) ?? [];
    arr.push(s);
    byDate.set(key, arr);
  }

  // Walk every calendar day from first session to today
  const firstDate = new Date(allSessions[0]!.startedAt);
  firstDate.setHours(0, 0, 0, 0);
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);

  let longest = 0;
  let current = 0;
  const d = new Date(firstDate);

  while (d <= todayDate) {
    const sessions = byDate.get(toDateString(d)) ?? [];
    if (dayMetGoal(sessions, goalMinutes)) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
    d.setDate(d.getDate() + 1);
  }

  return longest;
}

// ─── GET /metrics/daily ──────────────────────────────────────────────────────
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
    const daySessions = allSessions.filter((s) => toDateString(s.startedAt) === dateStr);

    const sittingSessions = daySessions.filter((s) => s.mode === "sitting");
    const sittingMinutes = getMinutes(daySessions, "sitting");
    const standingMinutes = getMinutes(daySessions, "standing");
    const napMinutes = getMinutes(daySessions, "resting", "nap");
    const sleepMinutes = getMinutes(daySessions, "resting", "sleep");
    const activeMinutes = sittingMinutes + standingMinutes;
    const goalProgressPercent =
      goalMinutes > 0
        ? Math.min(100, Math.round((standingMinutes / goalMinutes) * 100))
        : 0;
    const score = computeHealthScore(standingMinutes, sittingSessions, settings);

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

// ─── GET /metrics/summary ────────────────────────────────────────────────────
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

  // Last 7 days — fetch standing sessions in one query
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 6);
  weekAgo.setHours(0, 0, 0, 0);

  const weekSessions = await db
    .select()
    .from(sessionsTable)
    .where(
      and(
        gte(sessionsTable.startedAt, weekAgo),
        lte(sessionsTable.startedAt, endOfDay(today)),
        isNotNull(sessionsTable.endedAt),
        eq(sessionsTable.mode, "standing"),
      ),
    );

  type DayStat = { date: string; standingMinutes: number };
  const last7Days: DayStat[] = [];
  let weeklyTotal = 0;

  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = toDateString(d);
    const daySessions = weekSessions.filter((s) => toDateString(s.startedAt) === dateStr);
    const mins = daySessions.reduce(
      (sum, s) => sum + Math.round((s.durationSeconds ?? 0) / 60),
      0,
    );
    last7Days.push({ date: dateStr, standingMinutes: mins });
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

  // Compute weekly health score from all sessions this week (standing + sitting for reminder rate)
  const allWeekSessions = await db
    .select()
    .from(sessionsTable)
    .where(
      and(
        gte(sessionsTable.startedAt, weekAgo),
        lte(sessionsTable.startedAt, endOfDay(today)),
        isNotNull(sessionsTable.endedAt),
      ),
    );
  const weekSittingSessions = allWeekSessions.filter((s) => s.mode === "sitting");
  const weekScore = computeHealthScore(weeklyAverageStandingMinutes, weekSittingSessions, settings);

  // Last 30 days — nap and sleep stats
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
          napSessions.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0) /
            napSessions.length /
            60,
        )
      : 0;

  const avgSleepDurationMinutes =
    sleepSessions.length > 0
      ? Math.round(
          sleepSessions.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0) /
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
      if (mins < 240) mins += 1440; // wrap midnight hours into previous-night bucket
      return mins;
    });

    const avg = startMinutes.reduce((a, b) => a + b, 0) / startMinutes.length;
    const variance =
      startMinutes.reduce((sum, m) => sum + Math.pow(m - avg, 2), 0) / startMinutes.length;
    const stddev = Math.round(Math.sqrt(variance));

    const avgHour = Math.floor((avg % 1440) / 60);
    const avgMin = Math.round((avg % 1440) % 60);
    const ampm = avgHour < 12 ? "AM" : "PM";
    const displayHour = avgHour % 12 === 0 ? 12 : avgHour % 12;
    const avgSleepStartFormatted = `${displayHour}:${String(avgMin).padStart(2, "0")} ${ampm}`;

    sleepConsistency = { avgSleepStartFormatted, stddevMinutes: stddev, sampleCount: sleepSessions.length };
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
