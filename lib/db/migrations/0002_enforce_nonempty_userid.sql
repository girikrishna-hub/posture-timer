-- Migration 0002: enforce non-empty userId on sessions and push_subscriptions
--
-- Context: rows with userId = '' were inserted when the server ran before
-- Clerk authentication was wired up. These orphan rows cause push
-- notifications to fire against a non-existent subscription bucket.
--
-- Order matters:
--   1. Terminate the invalid open sessions so the data is consistent before
--      the CHECK constraint is applied (an open session with userId='' would
--      cause the ALTER TABLE ... ADD CONSTRAINT to fail).
--   2. Remove push subscriptions that share the same invalid userId.
--   3. Drop the empty-string column defaults (the DEFAULT '' made silent
--      empty-userId inserts possible at the DB level).
--   4. Add CHECK constraints so the DB itself rejects future bad writes.

-- Step 1: close any open sessions with an empty userId
UPDATE "sessions"
SET "ended_at" = NOW()
WHERE ("user_id" = '' OR "user_id" IS NULL)
  AND "ended_at" IS NULL;
--> statement-breakpoint

-- Step 2: delete push subscriptions with empty/null userId
DELETE FROM "push_subscriptions"
WHERE "user_id" = '' OR "user_id" IS NULL;
--> statement-breakpoint

-- Step 3: drop the empty-string defaults so silent empty inserts are no longer possible
ALTER TABLE "sessions" ALTER COLUMN "user_id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ALTER COLUMN "user_id" DROP DEFAULT;
--> statement-breakpoint

-- Step 4: add CHECK constraints — the DB now enforces non-empty userId at write time
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_user_id_not_empty" CHECK (length("user_id") > 0);
--> statement-breakpoint
ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_user_id_not_empty" CHECK (length("user_id") > 0);
