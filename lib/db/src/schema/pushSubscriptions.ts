import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const pushSubscriptionsTable = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  // No default — subscriptions must be explicitly tied to a real Clerk userId.
  // The DB-level CHECK constraint (migration 0002) enforces length > 0.
  userId: text("user_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptionsTable).omit({ id: true });
export const selectPushSubscriptionSchema = createSelectSchema(pushSubscriptionsTable);

export type InsertPushSubscription = z.infer<typeof insertPushSubscriptionSchema>;
export type PushSubscription = typeof pushSubscriptionsTable.$inferSelect;
