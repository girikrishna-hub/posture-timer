import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sessionsRouter from "./sessions";
import settingsRouter from "./settings";
import statsRouter from "./stats";
import metricsRouter from "./metrics";
import fitbitRouter from "./fitbit";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sessionsRouter);
router.use(settingsRouter);
router.use(statsRouter);
router.use(metricsRouter);
router.use(fitbitRouter);

export default router;
