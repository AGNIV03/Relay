import jwt from "jsonwebtoken";
import { env, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from "./env.js";

export interface TokenPayload {
  sub: string; // user id
  role: "ADMIN" | "USER"; // informational only — requireAuth reads the role from the DB
  type: "access" | "refresh";
  // User.tokenVersion at issue time. Missing on tokens issued before revocation
  // existed — treat as 0 (see tokenVersionOf).
  tv?: number;
}

export function signAccessToken(userId: string, role: "ADMIN" | "USER", tokenVersion: number): string {
  return jwt.sign(
    { sub: userId, role, type: "access", tv: tokenVersion } satisfies TokenPayload,
    env.jwtSecret,
    { algorithm: "HS256", expiresIn: ACCESS_TOKEN_TTL },
  );
}

export function signRefreshToken(userId: string, role: "ADMIN" | "USER", tokenVersion: number): string {
  return jwt.sign(
    { sub: userId, role, type: "refresh", tv: tokenVersion } satisfies TokenPayload,
    env.jwtSecret,
    { algorithm: "HS256", expiresIn: REFRESH_TOKEN_TTL },
  );
}

export function verifyToken(token: string): TokenPayload {
  // Pin the algorithm so a token can't pick its own (e.g. "none" / key confusion).
  return jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as TokenPayload;
}

/** The token-version claim, with pre-revocation tokens (no `tv`) counting as 0. */
export function tokenVersionOf(payload: TokenPayload): number {
  return typeof payload.tv === "number" ? payload.tv : 0;
}
