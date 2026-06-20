import jwt from "jsonwebtoken";
import { env, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from "./env.js";

export interface TokenPayload {
  sub: string; // user id
  role: "ADMIN" | "USER";
  type: "access" | "refresh";
}

export function signAccessToken(userId: string, role: "ADMIN" | "USER"): string {
  return jwt.sign({ sub: userId, role, type: "access" } satisfies TokenPayload, env.jwtSecret, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

export function signRefreshToken(userId: string, role: "ADMIN" | "USER"): string {
  return jwt.sign({ sub: userId, role, type: "refresh" } satisfies TokenPayload, env.jwtSecret, {
    expiresIn: REFRESH_TOKEN_TTL,
  });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, env.jwtSecret) as TokenPayload;
}
