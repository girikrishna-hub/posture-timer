/**
 * assertValidUserId
 *
 * Hard guard against empty or blank userIds propagating into the data layer.
 * A real Clerk userId is never empty; receiving one here means either the
 * Clerk middleware was bypassed or there is a misconfiguration. Throw loudly
 * rather than silently writing bad data.
 *
 * Usage: call at the top of every service method that writes data for a user.
 */
export function assertValidUserId(userId: string): void {
  if (!userId || userId.trim() === "") {
    throw Object.assign(
      new Error(`invalid_user_id: received "${userId}"`),
      { code: "INVALID_USER_ID" },
    );
  }
}
