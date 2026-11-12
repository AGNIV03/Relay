import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/**
 * Rate-limit key for the client IP. Keyed on CF-Connecting-IP: the Cloudflare
 * tunnel always overwrites it with the real client IP, whereas X-Forwarded-For
 * (what req.ip derives from with `trust proxy` on) can be prefixed by the client,
 * letting an attacker rotate keys per request. req.ip is the fallback for direct
 * (non-tunnel) dev access. A custom keyGenerator also skips the library's
 * permissive-trust-proxy check, so no `validate` override is needed.
 */
export function clientIpKey(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  const client = typeof cf === "string" && cf.trim() ? cf.trim() : (req.ip ?? "unknown");
  return ipKeyGenerator(client); // collapses IPv6 to its /56 so it can't rotate addresses
}

const TOO_MANY = { error: "Too many requests. Please try again later." };

/** Per-IP limiter (for unauthenticated endpoints). */
export function ipLimiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: clientIpKey,
    message: TOO_MANY,
  });
}

/** Per-user limiter. Must run AFTER requireAuth (falls back to the IP otherwise). */
export function userLimiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => (req.user ? `u:${req.user.id}` : clientIpKey(req)),
    message: TOO_MANY,
  });
}
