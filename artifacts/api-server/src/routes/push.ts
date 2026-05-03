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
import { sessionRepository } from "../sessions/session.repository";
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
  // Belt-and-suspenders: requireAuth already rejects empty/null userIds, but
  // we guard again here to make the contract explicit for this specific route
  // and to produce a clear 400 (not 401) if something slips through.
  if (!req.userId || req.userId.trim() === "") {
    req.log.error(
      { event: "push.subscribe.invalid_user", userId: req.userId },
      "push/subscribe: rejected request with invalid userId",
    );
    return res.status(400).json({ error: "invalid_user_id" });
  }

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
 * Routes through the posture orchestrator so the orchestrator remains the
 * single authority on timer state. The timer is derived from the active
 * session in the DB rather than from client-supplied params.
 *
 * Override logging: if the client's requested mode differs from the actual
 * session mode in the DB, the discrepancy is logged at WARN level with the
 * event key "push.override" for observability. The response is unchanged.
 *
 * Response format: { ok: true, scheduled: boolean }
 */
router.post("/push/schedule", requireAuth, async (req, res) => {
  // Capture what the client wanted before the orchestrator overrides it.
  const requestedMode = (req.body as { mode?: string }).mode ?? null;

  await postureOrchestrator.syncTimerWithSession(req.userId);

  // Derive `scheduled` from actual in-process timer state after the sync.
  const scheduled = hasActivePostureTimer(req.userId);

  // Override detection: compare what the client asked for against what the
  // orchestrator actually did (driven by DB session state).
  const activeSession = await sessionRepository.findActiveSession(req.userId);
  const actualMode = activeSession?.mode ?? null;

  if (requestedMode !== null && requestedMode !== actualMode) {
    req.log.warn(
      {
        event: "push.override",
        requestedMode,
        actualMode,
        scheduled,
      },
      "Push schedule override detected — orchestrator used DB session state instead of requested mode",
    );
  }

  req.log.info({ scheduled, actualMode }, "Push schedule synced via orchestrator");
  return res.json({ ok: true, scheduled });
});

/**
 * DELETE /push/schedule
 *
 * Cancels the posture timer via the orchestrator — ensures the cancel is
 * logged, locked, and checked for consistency.
 *
 * Response format: { ok: true }
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
