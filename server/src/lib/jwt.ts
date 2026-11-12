import jwt from "jsonwebtoken";
import { env, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, MEDIA_TOKEN_TTL_MS } from "./env.js";

export interface TokenPayload {
  sub: string; // user id
  role: "ADMIN" | "USER"; // informational only — requireAuth reads the role from the DB
  // access: Bearer header on every route. refresh: only POST /auth/refresh.
  // media: only as `?token=` on the stream/cover routes.
  type: "access" | "refresh" | "media";
  // User.tokenVersion at issue time. Missing on tokens issued before revocation
  // existed — treat as 0 (see tokenVersionOf).
  tv?: number;
  // Refresh tokens only: id of the RefreshToken row (rotation + reuse detection).
  // Missing on legacy refresh tokens issued before rotation existed.
  jti?: string;
  exp?: number; // set by jsonwebtoken (seconds since epoch)
}

export function signAccessToken(userId: string, role: "ADMIN" | "USER", tokenVersion: number): string {
  return jwt.sign(
    { sub: userId, role, type: "access", tv: tokenVersion } satisfies TokenPayload,
    env.jwtSecret,
    { algorithm: "HS256", expiresIn: ACCESS_TOKEN_TTL },
  );
}

export function signRefreshToken(
  userId: string,
  role: "ADMIN" | "USER",
  tokenVersion: number,
  jti: string,
): string {
  return jwt.sign(
    { sub: userId, role, type: "refresh", tv: tokenVersion } satisfies TokenPayload,
    env.jwtSecret,
    { algorithm: "HS256", expiresIn: REFRESH_TOKEN_TTL, jwtid: jti },
  );
}

/** A media token + its expiry (POST /api/auth/media-token). */
export function signMediaToken(
  userId: string,
  role: "ADMIN" | "USER",
  tokenVersion: number,
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + MEDIA_TOKEN_TTL_MS);
  const token = jwt.sign(
    { sub: userId, role, type: "media", tv: tokenVersion } satisfies TokenPayload,
    env.jwtSecret,
    { algorithm: "HS256", expiresIn: Math.floor(MEDIA_TOKEN_TTL_MS / 1000) },
  );
  return { token, expiresAt };
}

export function verifyToken(token: string): TokenPayload {
  // Pin the algorithm so a token can't pick its own (e.g. "none" / key confusion).
  return jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as TokenPayload;
}

/** The token-version claim, with pre-revocation tokens (no `tv`) counting as 0. */
export function tokenVersionOf(payload: TokenPayload): number {
  return typeof payload.tv === "number" ? payload.tv : 0;
}
