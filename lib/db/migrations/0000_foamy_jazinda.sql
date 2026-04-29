CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"rest_type" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"daily_standing_goal_minutes" integer DEFAULT 120 NOT NULL,
	"sitting_alert_minutes" integer DEFAULT 45 NOT NULL,
	"standing_min_minutes" integer DEFAULT 10 NOT NULL,
	"standing_max_minutes" integer DEFAULT 15 NOT NULL,
	"reminder_interval_minutes" integer DEFAULT 1 NOT NULL,
	"reminders_count" integer DEFAULT 3 NOT NULL
);
