import { Router, type IRouter } from "express";
import crypto from "crypto";
import { db, fitbitConnectionsTable, fitbitAnalyticsTable } from "@workspace/db";
import { desc, eq, sql, and } from "drizzle-orm";
import {
  getFitbitAuthUrl,
  exchangeCodeForTokens,
} from "../services/fitbitService";
import {
  getCachedIntradayData,
  triggerPoll,
} from "../services/fitbitPoller";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

// state → userId — lets the OAuth callback look up who initiated the flow
const pendingStates = new Map<string, string>();

function getRedirectUri(req: { headers: Record<string, string | string[] | undefined>; hostname: string }): string {
  const replitDomains = process.env["REPLIT_DOMAINS"];
  const forwardedHost = req.headers["x-forwarded-host"];
  const domain =
    replitDomains?.split(",")[0]?.trim() ??
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(",")[0]?.trim() ??
    process.env["REPLIT_DEV_DOMAIN"] ??
    req.hostname;
  return `https://${domain}/api/fitbit/callback`;
}

router.get("/fitbit/status", requireAuth, async (req, res) => {
  const rows = await db
    .select()
    .from(fitbitConnectionsTable)
    .where(eq(fitbitConnectionsTable.userId, req.userId))
    .orderBy(desc(fitbitConnectionsTable.id))
    .limit(1);

  if (rows.length === 0) {
    return res.json({ connected: false });
  }

  const conn = rows[0];
  return res.json({
    connected: true,
    expiresAt: conn.expiresAt.toISOString(),
    connectedAt: conn.connectedAt.toISOString(),
  });
});

router.get("/fitbit/auth-url", requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, req.userId);
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);

  const redirectUri = getRedirectUri(req);
  const clientId = process.env["GOOGLE_FIT_CLIENT_ID"] ?? "";
  req.log.info(
    { hasClientId: clientId.length > 0, redirectUri },
    "Google Fit auth-url requested",
  );
  const url = getFitbitAuthUrl(redirectUri, state);
  return res.json({ url });
});

router.get("/fitbit/callback", async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code) {
    return res.status(400).send("Missing code parameter");
  }

  const userId = state ? pendingStates.get(state) : undefined;
  if (state) pendingStates.delete(state);

  if (!userId) {
    req.log.warn({ state }, "Fitbit OAuth state missing or expired");
    const appUrl = `https://${process.env["REPLIT_DEV_DOMAIN"] ?? req.hostname}/`;
    return res.redirect(`${appUrl}?fitbit=error`);
  }

  try {
    const redirectUri = getRedirectUri(req);
    await exchangeCodeForTokens(code, redirectUri, userId);
    triggerPoll();
    const appUrl = `https://${process.env["REPLIT_DEV_DOMAIN"] ?? req.hostname}/`;
    return res.redirect(`${appUrl}?fitbit=connected`);
  } catch (err) {
    req.log.error({ err }, "Fitbit callback error");
    const appUrl = `https://${process.env["REPLIT_DEV_DOMAIN"] ?? req.hostname}/`;
    return res.redirect(`${appUrl}?fitbit=error`);
  }
});

router.delete("/fitbit/disconnect", requireAuth, async (req, res) => {
  await db
    .delete(fitbitConnectionsTable)
    .where(eq(fitbitConnectionsTable.userId, req.userId));
  return res.status(204).send();
});

router.get("/fitbit/intraday", requireAuth, async (req, res) => {
  const rows = await db
    .select()
    .from(fitbitConnectionsTable)
    .where(eq(fitbitConnectionsTable.userId, req.userId))
    .limit(1);

  if (rows.length === 0) {
    return res.status(404).json({ error: "No Fitbit connection" });
  }

  const data = getCachedIntradayData();
  if (!data) {
    return res.json({
      minutes: [],
      fetchedAt: new Date().toISOString(),
      signal: "unknown",
    });
  }

  return res.json({
    minutes: data.minutes,
    fetchedAt: data.fetchedAt.toISOString(),
    signal: data.signal,
  });
});

router.get("/fitbit/analytics", requireAuth, async (req, res) => {
  const rows = await db
    .select({
      eventType: fitbitAnalyticsTable.eventType,
      count: sql<number>`count(*)::int`,
    })
    .from(fitbitAnalyticsTable)
    .where(eq(fitbitAnalyticsTable.userId, req.userId))
    .groupBy(fitbitAnalyticsTable.eventType);

  const totals = {
    nudgeCount: 0,
    autoCorrectionCount: 0,
    userAcceptedCount: 0,
    userCancelledCount: 0,
  };

  for (const row of rows) {
    if (row.eventType === "nudge") totals.nudgeCount = row.count;
    if (row.eventType === "auto_correction") totals.autoCorrectionCount = row.count;
    if (row.eventType === "user_accepted") totals.userAcceptedCount = row.count;
    if (row.eventType === "user_cancelled") totals.userCancelledCount = row.count;
  }

  return res.json(totals);
});

router.post("/fitbit/analytics/event", requireAuth, async (req, res) => {
  const { eventType, fromMode, toMode, reason } = req.body as {
    eventType: string;
    fromMode: string;
    toMode: string;
    reason?: string;
  };

  const validEvents = ["nudge", "auto_correction", "user_accepted", "user_cancelled"];
  const validModes = ["sitting", "standing", "resting", "walking"];

  if (!validEvents.includes(eventType) || !validModes.includes(fromMode) || !validModes.includes(toMode)) {
    return res.status(400).json({ error: "Invalid event data" });
  }

  await db.insert(fitbitAnalyticsTable).values({
    userId: req.userId,
    eventType: eventType as "nudge" | "auto_correction" | "user_accepted" | "user_cancelled",
    fromMode: fromMode as "sitting" | "standing" | "resting" | "walking",
    toMode: toMode as "sitting" | "standing" | "resting" | "walking",
    reason: reason ?? "",
  });

  return res.status(201).json({ ok: true });
});

export default router;
