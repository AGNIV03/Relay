import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: "ADMIN" | "USER" };
    }
  }
}

/**
 * Reads a Bearer token from the Authorization header, OR a `?token=` query param
 * (the latter lets <audio>/<img> tags authenticate stream + cover URLs, which
 * cannot set headers).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const headerToken = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = headerToken ?? (typeof req.query.token === "string" ? req.query.token : undefined);

  if (!token) return res.status(401).json({ error: "Authentication required" });

  try {
    const payload = verifyToken(token);
    if (payload.type !== "access") return res.status(401).json({ error: "Invalid token type" });
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "ADMIN") return res.status(403).json({ error: "Admin access required" });
  next();
}
