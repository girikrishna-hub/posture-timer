import { Router, type IRouter } from "express";
import crypto from "crypto";
import { db, fitbitConnectionsTable, fitbitAnalyticsTable } from "@workspace/db";
import { desc, sql } from "drizzle-orm";
import {
  getFitbitAuthUrl,
  exchangeCodeForTokens,
} from "../services/fitbitService";
import {
  getCachedIntradayData,
  triggerPoll,
} from "../services/fitbitPoller";

const router: IRouter = Router();

const pendingStates = new Set<string>();

function getRedirectUri(req: { protocol: string; hostname: string }): string {
  const domain =
    process.env["REPLIT_DEV_DOMAIN"] ??
    `${req.hostname}`;
  return `https://${domain}/api/fitbit/callback`;
}

router.get("/fitbit/status", async (req, res) => {
  const rows = await db
    .select()
    .from(fitbitConnectionsTable)
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

router.get("/fitbit/auth-url", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);

  const redirectUri = getRedirectUri(req);
  const url = getFitbitAuthUrl(redirectUri, state);
  return res.json({ url });
});

router.get("/fitbit/callback", async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code) {
    return res.status(400).send("Missing code parameter");
  }

  if (state && !pendingStates.has(state)) {
    req.log.warn({ state }, "Fitbit OAuth state mismatch");
  }
  if (state) pendingStates.delete(state);

  try {
    const redirectUri = getRedirectUri(req);
    await exchangeCodeForTokens(code, redirectUri);
    triggerPoll();
    const appUrl =
      `https://${process.env["REPLIT_DEV_DOMAIN"] ?? req.hostname}/`;
    return res.redirect(`${appUrl}?fitbit=connected`);
  } catch (err) {
    req.log.error({ err }, "Fitbit callback error");
    const appUrl =
      `https://${process.env["REPLIT_DEV_DOMAIN"] ?? req.hostname}/`;
    return res.redirect(`${appUrl}?fitbit=error`);
  }
});

router.delete("/fitbit/disconnect", async (_req, res) => {
  await db.delete(fitbitConnectionsTable);
  return res.status(204).send();
});

router.get("/fitbit/intraday", async (_req, res) => {
  const rows = await db
    .select()
    .from(fitbitConnectionsTable)
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

router.get("/fitbit/analytics", async (_req, res) => {
  const rows = await db
    .select({
      eventType: fitbitAnalyticsTable.eventType,
      count: sql<number>`count(*)::int`,
    })
    .from(fitbitAnalyticsTable)
    .groupBy(fitbitAnalyticsTable.eventType);

  const totals = {
    nudgeCount: 0,
    autoCorrectionCount: 0,
    userAcceptedCount: 0,
    userCancelledCount: 0,
  };

  for (const row of rows) {
    if (row.eventType === "nudge") totals.nudgeCount = row.count;
    if (row.eventType === "auto_correction")
      totals.autoCorrectionCount = row.count;
    if (row.eventType === "user_accepted") totals.userAcceptedCount = row.count;
    if (row.eventType === "user_cancelled")
      totals.userCancelledCount = row.count;
  }

  return res.json(totals);
});

router.post("/fitbit/analytics/event", async (req, res) => {
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
    eventType: eventType as "nudge" | "auto_correction" | "user_accepted" | "user_cancelled",
    fromMode: fromMode as "sitting" | "standing" | "resting" | "walking",
    toMode: toMode as "sitting" | "standing" | "resting" | "walking",
    reason: reason ?? "",
  });

  return res.status(201).json({ ok: true });
});

export default router;
