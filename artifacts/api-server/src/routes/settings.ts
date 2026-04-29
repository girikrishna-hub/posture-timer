import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import { UpdateSettingsBody } from "@workspace/api-zod";

const router: IRouter = Router();

async function getOrCreateSettings() {
  const [existing] = await db.select().from(settingsTable).limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(settingsTable)
    .values({
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
  };
}

router.get("/settings", async (_req, res) => {
  const settings = await getOrCreateSettings();
  res.json(formatSettings(settings));
});

router.patch("/settings", async (req, res) => {
  const parse = UpdateSettingsBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid request body", details: parse.error.issues });
    return;
  }

  const settings = await getOrCreateSettings();

  const [updated] = await db
    .update(settingsTable)
    .set(parse.data)
    .where(eq(settingsTable.id, settings.id))
    .returning();

  res.json(formatSettings(updated));
});

export default router;
