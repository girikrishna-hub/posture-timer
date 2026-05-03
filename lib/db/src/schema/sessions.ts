import { pgTable, serial, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";

export const sessionsTable = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    // No default — every session must be explicitly associated with a Clerk userId.
    // The DB-level CHECK constraint (migration 0002) enforces length > 0.
    userId: text("user_id").notNull(),
    mode: text("mode", { enum: ["sitting", "standing", "resting", "walking"] }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    restType: text("rest_type", { enum: ["nap", "sleep"] }),
  },
  (table) => [
    uniqueIndex("sessions_one_active_per_user")
      .on(table.userId)
      .where(sql`${table.endedAt} IS NULL`),
  ],
);

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({ id: true });
export const selectSessionSchema = createSelectSchema(sessionsTable);

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;
