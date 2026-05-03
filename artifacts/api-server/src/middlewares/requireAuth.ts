import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";

declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const { userId } = getAuth(req);
  // Reject missing (null) AND empty / whitespace-only userIds.
  // Clerk never issues blank user IDs for authenticated sessions; receiving
  // one means the request is unauthenticated or the token is malformed.
  if (!userId || userId.trim() === "") {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  next();
}
