import { Router, type IRouter } from "express";
import {
  vapidPublicKey,
  saveSubscription,
  deleteSubscription,
  hasSubscription,
} from "../services/pushService";
import {
  hasActivePostureTimer,
  scheduleBladderPush,
  cancelBladderPush,
} from "../services/pushScheduler";
import { postureOrchestrator } from "../orchestrators/posture.orchestrator";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.get("/push/vapid-public-key", (_req, res) => {
  return res.json({ publicKey: vapidPublicKey });
});

router.get("/push/has-subscription", requireAuth, async (req, res) => {
  const has = await hasSubscription(req.userId);
  return res.json({ hasSubscription: has });
});

router.post("/push/subscribe", requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Missing subscription fields" });
  }

  await saveSubscription(req.userId, endpoint, keys.p256dh, keys.auth);
  return res.status(201).json({ ok: true });
});

router.delete("/push/subscribe", requireAuth, async (req, res) => {
  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint) return res.status(400).json({ error: "Missing endpoint" });
  await deleteSubscription(endpoint);
  return res.status(204).send();
});

/**
 * POST /push/schedule
 *
 * Previously scheduled timers directly via pushScheduler. Now routes through
 * the posture orchestrator so the orchestrator remains the single authority on
 * timer state. The timer is derived from the current active session in the DB
 * rather than from client-supplied params, keeping the two sources in sync.
 *
 * Response format is unchanged: { ok: true, scheduled: boolean }
 */
router.post("/push/schedule", requireAuth, async (req, res) => {
  await postureOrchestrator.syncTimerWithSession(req.userId);

  // Derive `scheduled` from actual in-process timer state after the sync.
  const scheduled = hasActivePostureTimer(req.userId);
  req.log.info({ scheduled }, "Push schedule synced via orchestrator");
  return res.json({ ok: true, scheduled });
});

/**
 * DELETE /push/schedule
 *
 * Cancels the posture timer via the orchestrator so the cancel is recorded,
 * logged, and checked for consistency — identical net effect to the previous
 * direct cancelPushSchedule() call.
 *
 * Response format is unchanged: { ok: true }
 */
router.delete("/push/schedule", requireAuth, async (req, res) => {
  await postureOrchestrator.onSessionEnded(req.userId, null);
  return res.json({ ok: true });
});

router.post("/push/bladder-schedule", requireAuth, (req, res) => {
  const { delayMs, logId } = req.body as { delayMs?: number; logId?: string };

  if (typeof delayMs !== "number" || delayMs < 0 || !logId) {
    return res.status(400).json({ error: "delayMs (number ≥ 0) and logId are required" });
  }

  scheduleBladderPush(req.userId, delayMs, logId);
  req.log.info({ delayMs, logId }, "Bladder push scheduled");
  return res.json({ ok: true, scheduled: true });
});

router.delete("/push/bladder-schedule", requireAuth, (req, res) => {
  cancelBladderPush(req.userId);
  return res.json({ ok: true });
});

export default router;
