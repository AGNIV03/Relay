// Rotating refresh tokens with reuse detection.
//
// Every refresh token carries a `jti` = RefreshToken.id. Refreshing consumes the
// presented token (usedAt) and issues a new one in the same family. Presenting a
// token that was already used (outside a short grace window) or revoked means a
// copy is in someone else's hands: the whole family is revoked and the caller
// gets a 401, so both the thief and the victim must sign in again.
//
// Legacy refresh tokens (issued before rotation, no jti) are accepted once: the
// token's hash is recorded as a used row in a new family, so a second use of the
// same legacy token is detected as reuse.
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { signRefreshToken, tokenVersionOf, type TokenPayload } from "./jwt.js";
import { REFRESH_TOKEN_TTL_MS } from "./env.js";

// A just-used token presented again within this window is treated as a client
// retry (response lost on a flaky network), not theft: it gets a fresh pair in
// the same family instead of revoking it.
const REUSE_GRACE_MS = 30_000;

type SessionUser = { id: string; role: "ADMIN" | "USER"; tokenVersion: number };

/** Issue a refresh token (new family unless `familyId` is given). */
export async function issueRefreshToken(user: SessionUser, familyId?: string): Promise<string> {
  const id = randomUUID();
  await prisma.refreshToken.create({
    data: {
      id,
      userId: user.id,
      familyId: familyId ?? randomUUID(),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });
  return signRefreshToken(user.id, user.role, user.tokenVersion, id);
}

export class RefreshRejectedError extends Error {}

/**
 * Consume a verified refresh token and return the replacement refresh token
 * (the caller signs the access token). Throws RefreshRejectedError on reuse,
 * revocation, expiry or an unknown token.
 */
export async function rotateRefreshToken(
  payload: TokenPayload,
  rawToken: string,
  user: SessionUser,
): Promise<string> {
  if (tokenVersionOf(payload) !== user.tokenVersion) throw new RefreshRejectedError("revoked");
  const now = new Date();

  if (!payload.jti) {
    // Legacy token: allow exactly one exchange, remembered by its hash.
    const legacyId = `legacy_${createHash("sha256").update(rawToken).digest("hex")}`;
    const familyId = randomUUID();
    const expiresAt = payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    try {
      await prisma.refreshToken.create({
        data: { id: legacyId, userId: user.id, familyId, expiresAt, usedAt: now },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
      // Row exists (unique violation): this legacy token was already exchanged.
      await revokeFamilyOf(legacyId);
      throw new RefreshRejectedError("reuse");
    }
    return issueRefreshToken(user, familyId);
  }

  // Atomically claim the token: only one request can flip usedAt from null.
  const claimed = await prisma.refreshToken.updateMany({
    where: {
      id: payload.jti,
      userId: user.id,
      usedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: { usedAt: now },
  });
  const row = await prisma.refreshToken.findUnique({ where: { id: payload.jti } });
  if (!row || row.userId !== user.id) throw new RefreshRejectedError("unknown");
  if (claimed.count === 1) return issueRefreshToken(user, row.familyId);

  if (
    !row.revokedAt &&
    row.usedAt &&
    row.expiresAt > now &&
    now.getTime() - row.usedAt.getTime() <= REUSE_GRACE_MS
  ) {
    return issueRefreshToken(user, row.familyId); // client retry
  }
  // Used (outside the grace window), revoked or expired → treat as theft.
  await revokeFamily(row.familyId);
  throw new RefreshRejectedError("reuse");
}

async function revokeFamily(familyId: string) {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

async function revokeFamilyOf(id: string) {
  const row = await prisma.refreshToken.findUnique({ where: { id }, select: { familyId: true } });
  if (row) await revokeFamily(row.familyId);
}

/** Revoke every refresh token a user holds (password change / sign out everywhere). */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ---- Pruning -----------------------------------------------------------------
// Expired rows are useless (the JWT itself no longer verifies). Used/revoked rows
// are kept 90 days for reuse detection; after that an old token is still rejected
// (row not found), it just no longer revokes its family.
const KEEP_SPENT_MS = 90 * 24 * 60 * 60 * 1000;

async function pruneRefreshTokens() {
  const now = Date.now();
  const spentBefore = new Date(now - KEEP_SPENT_MS);
  try {
    const r = await prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date(now) } },
          { usedAt: { lt: spentBefore } },
          { revokedAt: { lt: spentBefore } },
        ],
      },
    });
    if (r.count) console.log(`[auth] pruned ${r.count} refresh token rows`);
  } catch (e) {
    console.warn("[auth] refresh token prune failed:", (e as Error).message);
  }
}

/** Start the periodic prune (call once at startup). */
export function startRefreshTokenPrune(): void {
  setTimeout(pruneRefreshTokens, 60_000).unref();
  setInterval(pruneRefreshTokens, 6 * 60 * 60_000).unref();
}
