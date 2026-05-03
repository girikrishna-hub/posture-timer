import type { Request, Response } from "express";
import { sessionService } from "./session.service";
import { SessionInvariantError } from "./session.invariants";
import {
  StartSessionBody,
  EndSessionParams,
  EndSessionBody,
  ListSessionsQueryParams,
} from "@workspace/api-zod";

export const sessionController = {
  // GET /sessions/active
  async getActive(req: Request, res: Response): Promise<void> {
    const session = await sessionService.getActiveSession(req.userId);
    res.json({ session });
  },

  // POST /sessions
  async start(req: Request, res: Response): Promise<void> {
    const parse = StartSessionBody.safeParse(req.body);
    if (!parse.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parse.error.issues });
      return;
    }

    try {
      const session = await sessionService.startSession(
        req.userId,
        parse.data,
      );
      res.status(201).json(session);
    } catch (err) {
      if (err instanceof SessionInvariantError) {
        req.log.error({ err }, "Session invariant violated on start");
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  },

  // PATCH /sessions/:id
  async end(req: Request, res: Response): Promise<void> {
    const paramsResult = EndSessionParams.safeParse(req.params);
    if (!paramsResult.success) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }

    const bodyResult = EndSessionBody.safeParse(req.body ?? {});
    if (!bodyResult.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: bodyResult.error.issues });
      return;
    }

    try {
      const session = await sessionService.endSession(
        req.userId,
        paramsResult.data.id,
        bodyResult.data,
      );
      res.json(session);
    } catch (err) {
      if ((err as { code?: string }).code === "NOT_FOUND") {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (err instanceof SessionInvariantError) {
        req.log.error({ err }, "Session invariant violated on end");
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  },

  // GET /sessions
  async list(req: Request, res: Response): Promise<void> {
    const rawQuery = {
      ...req.query,
      from:
        typeof req.query.from === "string"
          ? new Date(req.query.from)
          : undefined,
      to:
        typeof req.query.to === "string" ? new Date(req.query.to) : undefined,
    };

    const queryResult = ListSessionsQueryParams.safeParse(rawQuery);
    if (!queryResult.success) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: queryResult.error.issues,
      });
      return;
    }

    const { sessions, total } = await sessionService.listSessions(
      req.userId,
      queryResult.data,
    );
    res.json({ sessions, total });
  },

  // GET /sessions/export
  async exportCsv(req: Request, res: Response): Promise<void> {
    const rawSessions = await sessionService.exportSessions(req.userId);

    const header = "date,mode,rest_type,started_at,ended_at,duration_minutes\n";
    const rows = rawSessions
      .map((s) => {
        const date = s.startedAt.toISOString().split("T")[0] ?? "";
        const restType = s.restType ?? "";
        const endedAt = s.endedAt ? s.endedAt.toISOString() : "";
        const durationMinutes = s.durationSeconds
          ? (s.durationSeconds / 60).toFixed(2)
          : "";
        return `${date},${s.mode},${restType},${s.startedAt.toISOString()},${endedAt},${durationMinutes}`;
      })
      .join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="sit-stand-sessions.csv"',
    );
    res.send(header + rows);
  },
};
