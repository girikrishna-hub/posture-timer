import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

async function getOrCreateSettings(userId: string) {
  const [existing] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(settingsTable)
    .values({
      userId,
      dailyStandingGoalMinutes: 120,
      sittingAlertMinutes: 45,
      standingMinMinutes: 10,
      standingMaxMinutes: 15,
      reminderIntervalMinutes: 1,
      remindersCount: 3,
    })
    .returning();
  return created;
}

function formatSettings(s: typeof settingsTable.$inferSelect) {
  return {
    id: s.id,
    dailyStandingGoalMinutes: s.dailyStandingGoalMinutes,
    sittingAlertMinutes: s.sittingAlertMinutes,
    standingMinMinutes: s.standingMinMinutes,
    standingMaxMinutes: s.standingMaxMinutes,
    reminderIntervalMinutes: s.reminderIntervalMinutes,
    remindersCount: s.remindersCount,
    autoDetectWalking: s.autoDetectWalking,
  };
}

router.get("/settings", requireAuth, async (req, res) => {
  const settings = await getOrCreateSettings(req.userId);
  res.json(formatSettings(settings));
});

router.patch("/settings", requireAuth, async (req, res) => {
  const parse = UpdateSettingsBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request body", details: parse.error.issues });
    return;
  }

  const settings = await getOrCreateSettings(req.userId);

  const [updated] = await db
    .update(settingsTable)
    .set(parse.data)
    .where(and(eq(settingsTable.id, settings.id), eq(settingsTable.userId, req.userId)))
    .returning();

  res.json(formatSettings(updated));
});

export default router;
