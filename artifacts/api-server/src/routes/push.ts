import { Router, type IRouter } from "express";
import {
  vapidPublicKey,
  saveSubscription,
  deleteSubscription,
} from "../services/pushService";
import {
  schedulePushNotifications,
  cancelPushSchedule,
  scheduleBladderPush,
  cancelBladderPush,
} from "../services/pushScheduler";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.get("/push/vapid-public-key", (_req, res) => {
  return res.json({ publicKey: vapidPublicKey });
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

router.post("/push/schedule", requireAuth, (req, res) => {
  const {
    mode,
    elapsedSeconds = 0,
    sittingAlertMinutes = 45,
    standingMinMinutes = 10,
    standingMaxMinutes = 15,
    reminderIntervalMinutes = 1,
    remindersCount = 3,
  } = req.body as {
    mode?: string;
    elapsedSeconds?: number;
    sittingAlertMinutes?: number;
    standingMinMinutes?: number;
    standingMaxMinutes?: number;
    reminderIntervalMinutes?: number;
    remindersCount?: number;
  };

  if (mode !== "sitting" && mode !== "standing") {
    cancelPushSchedule(req.userId);
    return res.json({ ok: true, scheduled: false });
  }

  schedulePushNotifications(req.userId, {
    mode,
    elapsedSeconds,
    sittingAlertMinutes,
    standingMinMinutes,
    standingMaxMinutes,
    reminderIntervalMinutes,
    remindersCount,
  });

  req.log.info({ mode, elapsedSeconds }, "Push schedule set");
  return res.json({ ok: true, scheduled: true });
});

router.delete("/push/schedule", requireAuth, (req, res) => {
  cancelPushSchedule(req.userId);
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
