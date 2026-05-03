-- Migration 0003: add tables/columns that were previously applied via push,
-- and enforce one-active-session-per-user with a partial unique index.
--
-- All DDL statements use IF NOT EXISTS so this migration is safe to run even
-- if a previous partial attempt already created some of these objects.
--
-- The unique index creation is preceded by a data-cleanup step that ends any
-- duplicate active sessions (keeping the most recent one per user). Without
-- this, PostgreSQL cannot build the partial unique index when a user has more
-- than one row with ended_at IS NULL.

-- ── New tables (may already exist from prior push) ────────────────────────

CREATE TABLE IF NOT EXISTS "fitbit_analytics" (
        "id" serial PRIMARY KEY NOT NULL,
        "user_id" text DEFAULT '' NOT NULL,
        "event_type" text NOT NULL,
        "from_mode" text NOT NULL,
        "to_mode" text NOT NULL,
        "reason" text DEFAULT '' NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fitbit_connections" (
        "id" serial PRIMARY KEY NOT NULL,
        "user_id" text DEFAULT '' NOT NULL,
        "access_token" text NOT NULL,
        "refresh_token" text NOT NULL,
        "expires_at" timestamp with time zone NOT NULL,
        "scope" text DEFAULT '' NOT NULL,
        "connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
        "id" serial PRIMARY KEY NOT NULL,
        "user_id" text NOT NULL,
        "endpoint" text NOT NULL,
        "p256dh" text NOT NULL,
        "auth" text NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint

-- ── New columns on existing tables (may already exist from prior push) ─────

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "user_id" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "user_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "auto_detect_walking" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- ── Data cleanup: end duplicate active sessions before creating the index ──
--
-- If a user somehow has more than one open session (ended_at IS NULL), the
-- partial unique index below cannot be created. This UPDATE closes all but the
-- most recently started session for each user, so the index can be built
-- cleanly. The most recent session is identified by the highest started_at;
-- ties are broken by the highest id.

UPDATE "sessions"
SET "ended_at" = NOW()
WHERE "ended_at" IS NULL
  AND "id" NOT IN (
    SELECT DISTINCT ON ("user_id") "id"
    FROM "sessions"
    WHERE "ended_at" IS NULL
    ORDER BY "user_id", "started_at" DESC, "id" DESC
  );
--> statement-breakpoint

-- ── Partial unique index: one active session per user ──────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "sessions_one_active_per_user"
  ON "sessions" USING btree ("user_id")
  WHERE "sessions"."ended_at" IS NULL;
