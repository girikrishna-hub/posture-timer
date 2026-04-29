import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const sessionsTable = pgTable("sessions", {
  id: serial("id").primaryKey(),
  mode: text("mode", { enum: ["sitting", "standing", "resting"] }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
  restType: text("rest_type", { enum: ["nap", "sleep"] }),
});

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({ id: true });
export const selectSessionSchema = createSelectSchema(sessionsTable);

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;
