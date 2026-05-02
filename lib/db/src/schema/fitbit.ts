import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const fitbitConnectionsTable = pgTable("fitbit_connections", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default(""),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scope: text("scope").notNull().default(""),
  connectedAt: timestamp("connected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const fitbitAnalyticsTable = pgTable("fitbit_analytics", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default(""),
  eventType: text("event_type", {
    enum: ["nudge", "auto_correction", "user_accepted", "user_cancelled"],
  }).notNull(),
  fromMode: text("from_mode", {
    enum: ["sitting", "standing", "resting", "walking"],
  }).notNull(),
  toMode: text("to_mode", {
    enum: ["sitting", "standing", "resting", "walking"],
  }).notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertFitbitConnectionSchema = createInsertSchema(
  fitbitConnectionsTable,
).omit({ id: true });
export const selectFitbitConnectionSchema =
  createSelectSchema(fitbitConnectionsTable);

export const insertFitbitAnalyticsSchema = createInsertSchema(
  fitbitAnalyticsTable,
).omit({ id: true });
export const selectFitbitAnalyticsSchema =
  createSelectSchema(fitbitAnalyticsTable);

export type InsertFitbitConnection = z.infer<
  typeof insertFitbitConnectionSchema
>;
export type FitbitConnection = typeof fitbitConnectionsTable.$inferSelect;
export type InsertFitbitAnalytics = z.infer<typeof insertFitbitAnalyticsSchema>;
export type FitbitAnalytics = typeof fitbitAnalyticsTable.$inferSelect;

export const fitbitModeEnum = [
  "sitting",
  "standing",
  "resting",
  "walking",
] as const;
export const fitbitEventEnum = [
  "nudge",
  "auto_correction",
  "user_accepted",
  "user_cancelled",
] as const;
