import "./helpers/env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateInviteCode, normalizeInviteCode, consumeInvite, InviteError } from "../src/lib/invites.js";

const SHAPE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{2}$/;

describe("generateInviteCode", () => {
  it("produces XXXX-XXXX-XX from the unambiguous alphabet (no 0/O/1/I/L)", () => {
    for (let i = 0; i < 500; i++) {
      const c = generateInviteCode();
      assert.match(c, SHAPE);
      assert.doesNotMatch(c, /[01OIL]/);
    }
  });

  it("is random (no collisions in 2000 draws)", () => {
    const seen = new Set(Array.from({ length: 2000 }, generateInviteCode));
    assert.equal(seen.size, 2000);
  });

  it("is already in normalized form", () => {
    const c = generateInviteCode();
    assert.equal(normalizeInviteCode(c), c);
  });
});

describe("normalizeInviteCode", () => {
  it("ignores case, spaces and separators", () => {
    assert.equal(normalizeInviteCode("k7qm-3xrp-t9"), "K7QM-3XRP-T9");
    assert.equal(normalizeInviteCode(" K7QM 3XRP T9 "), "K7QM-3XRP-T9");
    assert.equal(normalizeInviteCode("k7qm3xrpt9"), "K7QM-3XRP-T9");
    assert.equal(normalizeInviteCode("K7QM_3XRP.T9"), "K7QM-3XRP-T9");
  });

  it("returns wrong-length input stripped but unformatted (so it never matches a stored code)", () => {
    assert.equal(normalizeInviteCode("abc-123"), "ABC123");
    assert.equal(normalizeInviteCode(""), "");
    assert.equal(normalizeInviteCode("K7QM-3XRP-T9X"), "K7QM3XRPT9X");
  });
});

describe("consumeInvite", () => {
  function fakeTx(count: number, role: "ADMIN" | "USER" | null) {
    const seen: { where?: Record<string, unknown>; data?: unknown } = {};
    const tx = {
      inviteCode: {
        updateMany: async (args: { where: Record<string, unknown>; data: unknown }) => {
          Object.assign(seen, args);
          return { count };
        },
        findUnique: async () => (role ? { role } : null),
      },
    };
    return { tx: tx as unknown as Parameters<typeof consumeInvite>[0], seen };
  }

  it("atomically increments a usable invite and returns its role", async () => {
    const { tx, seen } = fakeTx(1, "ADMIN");
    assert.equal(await consumeInvite(tx, "K7QM-3XRP-T9"), "ADMIN");
    assert.deepEqual(seen.data, { uses: { increment: 1 } });
    // The guard: not revoked, not expired, uses below maxUses, all in the same UPDATE.
    assert.equal(seen.where!.code, "K7QM-3XRP-T9");
    assert.equal(seen.where!.revokedAt, null);
    assert.ok(Array.isArray(seen.where!.OR));
    assert.ok((seen.where!.uses as { lt?: unknown }).lt, "uses < maxUses");
  });

  it("throws InviteError when the guarded update matched nothing (raced / used up)", async () => {
    const { tx } = fakeTx(0, "USER");
    await assert.rejects(consumeInvite(tx, "X"), InviteError);
  });
});
