import { Router, type IRouter } from "express";
import {
  vapidPublicKey,
  saveSubscription,
  deleteSubscription,
} from "../services/pushService";
import {
  schedulePushNotifications,
  cancelPushSchedule,
} from "../services/pushScheduler";

const router: IRouter = Router();

router.get("/push/vapid-public-key", (_req, res) => {
  return res.json({ publicKey: vapidPublicKey });
});

router.post("/push/subscribe", async (req, res) => {
  const { endpoint, keys } = req.body as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Missing subscription fields" });
  }

  await saveSubscription(endpoint, keys.p256dh, keys.auth);
  return res.status(201).json({ ok: true });
});

router.delete("/push/subscribe", async (req, res) => {
  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint) return res.status(400).json({ error: "Missing endpoint" });
  await deleteSubscription(endpoint);
  return res.status(204).send();
});

router.post("/push/schedule", (req, res) => {
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
    cancelPushSchedule();
    return res.json({ ok: true, scheduled: false });
  }

  schedulePushNotifications({
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

router.delete("/push/schedule", (_req, res) => {
  cancelPushSchedule();
  return res.json({ ok: true });
});

export default router;
