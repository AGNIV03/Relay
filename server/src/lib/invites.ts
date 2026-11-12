// Admin-issued invite codes for self-registration.
import { randomInt } from "node:crypto";
import { prisma } from "./prisma.js";
import type { Prisma } from "../generated/prisma/client.js";

// No 0/O, 1/I/L: easy to read aloud and type from a screenshot.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 10;

/** Format 10 code characters as "XXXX-XXXX-XX". */
function format(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** A fresh random code, e.g. "K7QM-3XRP-T9". */
export function generateInviteCode(): string {
  let raw = "";
  for (let i = 0; i < CODE_LEN; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return format(raw);
}

/** Canonical stored form of user input: case and separators don't matter. */
export function normalizeInviteCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === CODE_LEN ? format(raw) : raw;
}

/** Where-clause for an invite that can still be used right now. */
function usableWhere(): Prisma.InviteCodeWhereInput {
  return {
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    uses: { lt: prisma.inviteCode.fields.maxUses },
  };
}

/** The invite if it exists and is usable (not revoked/expired/used up), else null. */
export async function findUsableInvite(code: string) {
  if (!code) return null;
  return prisma.inviteCode.findFirst({ where: { code, ...usableWhere() } });
}

/** Number of invites that can still be used. */
export function countActiveInvites(): Promise<number> {
  return prisma.inviteCode.count({ where: usableWhere() });
}

export class InviteError extends Error {}

/** Atomically use one of the invite's uses inside a transaction; returns its role.
 *  Throws InviteError when it's no longer usable (raced with another sign-up). */
export async function consumeInvite(
  tx: Prisma.TransactionClient,
  code: string,
): Promise<"ADMIN" | "USER"> {
  const r = await tx.inviteCode.updateMany({
    where: { code, ...usableWhere() },
    data: { uses: { increment: 1 } },
  });
  if (r.count !== 1) throw new InviteError("Invite not usable");
  const invite = await tx.inviteCode.findUnique({ where: { code }, select: { role: true } });
  if (!invite) throw new InviteError("Invite not usable");
  return invite.role;
}
