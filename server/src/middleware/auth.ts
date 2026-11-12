import type { Request, Response, NextFunction } from "express";
import { verifyToken, tokenVersionOf } from "../lib/jwt.js";
import { prisma } from "../lib/prisma.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: "ADMIN" | "USER" };
    }
  }
}

// ---- Auth-state cache ------------------------------------------------------
// requireAuth runs on every stream/cover request (a scrolling grid fires dozens),
// so the {role, tokenVersion} lookup is cached briefly per user. The cached value
// is a promise so a burst of concurrent misses shares one DB query. Anything that
// changes a user's role/tokenVersion or deletes them MUST call invalidateAuthCache.

type AuthState = { role: "ADMIN" | "USER"; tokenVersion: number } | null; // null = no such user
const AUTH_CACHE_TTL_MS = 30_000;
const AUTH_CACHE_MAX = 5_000;
const authCache = new Map<string, { at: number; state: Promise<AuthState> }>();

/** Drop a user's cached auth state (call after role/tokenVersion change or delete). */
export function invalidateAuthCache(userId: string): void {
  authCache.delete(userId);
}

/** The user's current role + token version (cached ~30s), or null if they're gone. */
export function getAuthState(userId: string): Promise<AuthState> {
  const now = Date.now();
  const hit = authCache.get(userId);
  if (hit && now - hit.at < AUTH_CACHE_TTL_MS) return hit.state;
  if (authCache.size >= AUTH_CACHE_MAX) {
    for (const [k, v] of authCache) if (now - v.at >= AUTH_CACHE_TTL_MS) authCache.delete(k);
    if (authCache.size >= AUTH_CACHE_MAX) authCache.clear();
  }
  const state = prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, tokenVersion: true },
  });
  authCache.set(userId, { at: now, state });
  // Don't cache DB failures — the next request retries.
  state.catch(() => {
    if (authCache.get(userId)?.state === state) authCache.delete(userId);
  });
  return state;
}

type Verified = { id: string; role: "ADMIN" | "USER" } | { status: number; error: string };

/** Verify a token of one of `types` against the DB auth state (role + revocation). */
async function authenticate(
  token: string,
  types: ReadonlyArray<"access" | "media">,
): Promise<Verified> {
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return { status: 401, error: "Invalid or expired token" };
  }
  // Refresh tokens are never accepted here (only by POST /auth/refresh).
  if (!(types as ReadonlyArray<string>).includes(payload.type)) {
    return { status: 401, error: "Invalid token type" };
  }
  const state = await getAuthState(payload.sub);
  if (!state || state.tokenVersion !== tokenVersionOf(payload)) {
    return { status: 401, error: "Invalid or expired token" };
  }
  return { id: payload.sub, role: state.role };
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

/**
 * Requires an ACCESS token in the `Authorization: Bearer` header. A `?token=`
 * query param is NOT accepted here (tokens in URLs leak into logs/history);
 * only the media routes take one (requireMediaAuth).
 *
 * The token only proves identity; the role and validity come from the DB (via the
 * cache above): a token whose `tv` no longer matches User.tokenVersion has been
 * revoked (password change / sign out everywhere / role change).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const v = await authenticate(token, ["access"]);
  if ("error" in v) return res.status(v.status).json({ error: v.error });
  req.user = { id: v.id, role: v.role };
  next();
}

/**
 * Auth for the media routes (stream + covers), which <audio>/<img> tags load and
 * so cannot send headers. Accepts a Bearer access token, or `?token=` holding a
 * MEDIA token (POST /api/auth/media-token) — or, for app builds that predate
 * media tokens, an access token.
 */
export async function requireMediaAuth(req: Request, res: Response, next: NextFunction) {
  const header = bearerToken(req);
  const query = typeof req.query.token === "string" ? req.query.token : undefined;
  const token = header ?? query;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  const v = await authenticate(token, header ? ["access"] : ["media", "access"]);
  if ("error" in v) return res.status(v.status).json({ error: v.error });
  req.user = { id: v.id, role: v.role };
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "ADMIN") return res.status(403).json({ error: "Admin access required" });
  next();
}
