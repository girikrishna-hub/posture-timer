/**
 * cleanup-invalid-sessions
 *
 * One-time script: terminates all open sessions with an empty or null userId
 * and removes push subscriptions with the same problem.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run cleanup-invalid-sessions
 *
 * Safe to run multiple times — subsequent runs will report 0 rows found.
 */

import { db, sessionsTable, pushSubscriptionsTable } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";

const invalidUserWhere = or(
  eq(sessionsTable.userId, ""),
  isNull(sessionsTable.userId as never),
);

async function main(): Promise<void> {
  console.log("=== cleanup-invalid-sessions ===\n");

  // ── Sessions ──────────────────────────────────────────────────────────────
  const openInvalid = await db
    .select({
      id: sessionsTable.id,
      userId: sessionsTable.userId,
      mode: sessionsTable.mode,
      startedAt: sessionsTable.startedAt,
    })
    .from(sessionsTable)
    .where(and(isNull(sessionsTable.endedAt), invalidUserWhere));

  console.log(`Open sessions with invalid userId: ${openInvalid.length}`);

  if (openInvalid.length > 0) {
    const now = new Date();
    for (const s of openInvalid) {
      await db
        .update(sessionsTable)
        .set({ endedAt: now })
        .where(eq(sessionsTable.id, s.id));
      console.log(
        `  ✓ Terminated session ${s.id}  userId="${s.userId}"  mode=${s.mode}  started=${s.startedAt.toISOString()}`,
      );
    }
    console.log(`\nTerminated ${openInvalid.length} open session(s).`);
  } else {
    console.log("  Nothing to do.");
  }

  // ── Push subscriptions ────────────────────────────────────────────────────
  const invalidSubs = await db
    .select({ id: pushSubscriptionsTable.id, userId: pushSubscriptionsTable.userId, endpoint: pushSubscriptionsTable.endpoint })
    .from(pushSubscriptionsTable)
    .where(
      or(
        eq(pushSubscriptionsTable.userId, ""),
        isNull(pushSubscriptionsTable.userId as never),
      ),
    );

  console.log(`\nPush subscriptions with invalid userId: ${invalidSubs.length}`);

  if (invalidSubs.length > 0) {
    for (const sub of invalidSubs) {
      await db
        .delete(pushSubscriptionsTable)
        .where(eq(pushSubscriptionsTable.id, sub.id));
      console.log(
        `  ✓ Deleted subscription ${sub.id}  userId="${sub.userId}"  endpoint=${sub.endpoint.slice(0, 60)}…`,
      );
    }
    console.log(`\nDeleted ${invalidSubs.length} invalid subscription(s).`);
  } else {
    console.log("  Nothing to do.");
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("Script failed:", err);
  process.exit(1);
});
