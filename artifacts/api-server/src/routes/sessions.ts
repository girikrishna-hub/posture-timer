import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { sessionController } from "../sessions/session.controller";

const router: IRouter = Router();

router.post("/sessions", requireAuth, (req, res) =>
  sessionController.start(req, res),
);

router.get("/sessions/export", requireAuth, (req, res) =>
  sessionController.exportCsv(req, res),
);

router.get("/sessions/active", requireAuth, (req, res) =>
  sessionController.getActive(req, res),
);

router.get("/sessions", requireAuth, (req, res) =>
  sessionController.list(req, res),
);

router.patch("/sessions/:id", requireAuth, (req, res) =>
  sessionController.end(req, res),
);

export default router;
