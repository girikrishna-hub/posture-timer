import { pgTable, serial, integer } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  dailyStandingGoalMinutes: integer("daily_standing_goal_minutes").notNull().default(120),
  sittingAlertMinutes: integer("sitting_alert_minutes").notNull().default(45),
  standingMinMinutes: integer("standing_min_minutes").notNull().default(10),
  standingMaxMinutes: integer("standing_max_minutes").notNull().default(15),
  reminderIntervalMinutes: integer("reminder_interval_minutes").notNull().default(1),
  remindersCount: integer("reminders_count").notNull().default(3),
});

export const insertSettingsSchema = createInsertSchema(settingsTable).omit({ id: true });
export const selectSettingsSchema = createSelectSchema(settingsTable);

export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settingsTable.$inferSelect;
