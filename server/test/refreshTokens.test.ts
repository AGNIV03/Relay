// Refresh-token rotation + reuse detection (lib/refreshTokens.ts) against an
// in-memory fake of the prisma.refreshToken calls it makes.
import "./helpers/env.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../src/lib/prisma.js";
import { verifyToken, type TokenPayload } from "../src/lib/jwt.js";
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeAllRefreshTokens,
  RefreshRejectedError,
} from "../src/lib/refreshTokens.js";
import { fakeModel } from "./helpers/fakeDb.js";

interface RtRow extends Record<string, unknown> {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

let db: ReturnType<typeof fakeModel<RtRow>>;
before(() => {
  // prisma.refreshToken is a plain writable property on the client instance.
  Object.defineProperty(prisma, "refreshToken", { get: () => db, configurable: true });
});
beforeEach(() => {
  db = fakeModel<RtRow>([]);
});

const alice = { id: "alice", role: "USER" as const, tokenVersion: 0 };
const bob = { id: "bob", role: "USER" as const, tokenVersion: 0 };
const row = (id: string) => db.rows.find((r) => r.id === id)!;
const rotate = (raw: string, user = alice) => rotateRefreshToken(verifyToken(raw), raw, user);
const rejects = (p: Promise<unknown>, reason: string) =>
  assert.rejects(p, (e: unknown) => e instanceof RefreshRejectedError && (e as Error).message === reason);

describe("issueRefreshToken", () => {
  it("creates a row in a fresh family and signs its id as the jti", async () => {
    const t = await issueRefreshToken(alice);
    const p = verifyToken(t);
    assert.equal(p.type, "refresh");
    assert.equal(db.rows.length, 1);
    const r = db.rows[0];
    assert.equal(p.jti, r.id);
    assert.equal(r.userId, "alice");
    assert.equal(r.usedAt, null);
    assert.ok(r.expiresAt.getTime() > Date.now() + 364 * 86_400_000);
    await issueRefreshToken(alice);
    assert.notEqual(db.rows[0].familyId, db.rows[1].familyId, "each login is its own family");
  });

  it("reuses the given family id", async () => {
    await issueRefreshToken(alice, "fam-x");
    assert.equal(db.rows[0].familyId, "fam-x");
  });
});

describe("rotateRefreshToken", () => {
  it("consumes the presented token and returns a new one in the same family", async () => {
    const t1 = await issueRefreshToken(alice);
    const j1 = verifyToken(t1).jti!;
    const t2 = await rotate(t1);
    const j2 = verifyToken(t2).jti!;
    assert.notEqual(j1, j2);
    assert.ok(row(j1).usedAt instanceof Date, "old token marked used");
    assert.equal(row(j2).usedAt, null);
    assert.equal(row(j2).familyId, row(j1).familyId);
    // The chain keeps working.
    const t3 = await rotate(t2);
    assert.equal(row(verifyToken(t3).jti!).familyId, row(j1).familyId);
  });

  it("treats a re-presented token within the 30 s grace window as a client retry", async () => {
    const t1 = await issueRefreshToken(alice);
    await rotate(t1);
    row(verifyToken(t1).jti!).usedAt = new Date(Date.now() - 10_000);
    const again = await rotate(t1);
    assert.equal(row(verifyToken(again).jti!).familyId, row(verifyToken(t1).jti!).familyId);
    assert.ok(db.rows.every((r) => r.revokedAt === null), "nothing revoked on a retry");
  });

  it("detects reuse after the grace window: rejects and revokes the whole family", async () => {
    const t1 = await issueRefreshToken(alice);
    const t2 = await rotate(t1);
    const other = await issueRefreshToken(alice); // a different device/family
    row(verifyToken(t1).jti!).usedAt = new Date(Date.now() - 31_000);
    await rejects(rotate(t1), "reuse");
    const fam = row(verifyToken(t1).jti!).familyId;
    for (const r of db.rows.filter((x) => x.familyId === fam)) assert.ok(r.revokedAt, `${r.id} revoked`);
    assert.equal(row(verifyToken(other).jti!).revokedAt, null, "other families untouched");
    // The thief's (or victim's) newer token is dead too.
    await rejects(rotate(t2), "reuse");
  });

  it("rejects a revoked token", async () => {
    const t = await issueRefreshToken(alice);
    await revokeAllRefreshTokens("alice");
    await rejects(rotate(t), "reuse");
  });

  it("rejects an expired row even if the JWT still verifies", async () => {
    const t = await issueRefreshToken(alice);
    row(verifyToken(t).jti!).expiresAt = new Date(Date.now() - 1000);
    await rejects(rotate(t), "reuse");
  });

  it("rejects an unknown jti", async () => {
    const t = await issueRefreshToken(alice);
    db.rows.length = 0;
    await rejects(rotate(t), "unknown");
  });

  it("rejects another user's token without consuming it", async () => {
    const t = await issueRefreshToken(alice);
    await rejects(rotate(t, bob), "unknown");
    assert.equal(row(verifyToken(t).jti!).usedAt, null);
  });

  it("rejects when the user's tokenVersion moved on (sign out everywhere) without touching the DB", async () => {
    const t = await issueRefreshToken(alice);
    const calls = db.calls.length;
    await rejects(rotate(t, { ...alice, tokenVersion: 1 }), "revoked");
    assert.equal(db.calls.length, calls);
  });

  it("concurrent refreshes with the same token: one claims it, the other is a grace retry", async () => {
    const t = await issueRefreshToken(alice);
    const [a, b] = await Promise.all([rotate(t), rotate(t)]);
    assert.notEqual(verifyToken(a).jti, verifyToken(b).jti);
    assert.ok(db.rows.every((r) => r.revokedAt === null));
  });

  it("legacy token (no jti) is accepted exactly once; the second use revokes the new family", async () => {
    const legacy = jwt.sign({ sub: "alice", role: "USER", type: "refresh", tv: 0 }, process.env.JWT_SECRET!, {
      algorithm: "HS256",
      expiresIn: "30d",
    });
    const p = verifyToken(legacy) as TokenPayload;
    assert.equal(p.jti, undefined);
    const fresh = await rotateRefreshToken(p, legacy, alice);
    const legacyId = `legacy_${createHash("sha256").update(legacy).digest("hex")}`;
    assert.ok(row(legacyId).usedAt, "legacy exchange recorded as a used row");
    assert.equal(row(verifyToken(fresh).jti!).familyId, row(legacyId).familyId);

    await rejects(rotateRefreshToken(p, legacy, alice), "reuse");
    assert.ok(row(verifyToken(fresh).jti!).revokedAt, "the family minted from the legacy token is revoked");
  });
});

describe("revokeAllRefreshTokens", () => {
  it("revokes only that user's tokens", async () => {
    await issueRefreshToken(alice);
    await issueRefreshToken(alice);
    await issueRefreshToken(bob);
    await revokeAllRefreshTokens("alice");
    assert.deepEqual(
      db.rows.map((r) => [r.userId, r.revokedAt !== null]),
      [
        ["alice", true],
        ["alice", true],
        ["bob", false],
      ],
    );
  });
});
