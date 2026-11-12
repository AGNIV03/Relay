// requireAuth / requireMediaAuth / requireAdmin against a faked prisma.user
// lookup: which token types each route family accepts, and revocation.
import "./helpers/env.js";
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../src/lib/prisma.js";
import { signAccessToken, signRefreshToken, signMediaToken } from "../src/lib/jwt.js";
import { requireAuth, requireMediaAuth, requireAdmin, invalidateAuthCache } from "../src/middleware/auth.js";

type Users = Record<string, { role: "ADMIN" | "USER"; tokenVersion: number }>;
let users: Users = {};

before(() => {
  // Replace the one query the middleware makes.
  (prisma as unknown as { user: unknown }).user = {
    findUnique: async ({ where }: { where: { id: string } }) => (users[where.id] ? { ...users[where.id] } : null),
  };
});
beforeEach(() => {
  users = { u1: { role: "USER", tokenVersion: 0 }, a1: { role: "ADMIN", tokenVersion: 2 } };
  for (const id of ["u1", "a1", "gone"]) invalidateAuthCache(id);
});

interface Result {
  status?: number;
  body?: unknown;
  nextCalled: boolean;
  user?: Request["user"];
}

async function run(
  mw: (req: Request, res: Response, next: NextFunction) => unknown,
  opts: { bearer?: string; query?: Record<string, unknown>; user?: Request["user"] },
): Promise<Result> {
  const req = {
    headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
    query: opts.query ?? {},
    user: opts.user,
  } as unknown as Request;
  const out: Result = { nextCalled: false };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
  } as unknown as Response;
  await mw(req, res, () => {
    out.nextCalled = true;
  });
  out.user = req.user;
  return out;
}

const access = () => signAccessToken("u1", "USER", 0);
const refresh = () => signRefreshToken("u1", "USER", 0, "jti-1");
const media = () => signMediaToken("u1", "USER", 0).token;

describe("requireAuth (Bearer access token only)", () => {
  it("accepts an access token and takes the role from the DB, not the token", async () => {
    users.u1.role = "ADMIN"; // token says USER; the DB wins
    const r = await run(requireAuth, { bearer: access() });
    assert.equal(r.nextCalled, true);
    assert.deepEqual(r.user, { id: "u1", role: "ADMIN" });
  });

  it("rejects a refresh token", async () => {
    const r = await run(requireAuth, { bearer: refresh() });
    assert.equal(r.nextCalled, false);
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "Invalid token type" });
  });

  it("rejects a media token in the header", async () => {
    const r = await run(requireAuth, { bearer: media() });
    assert.equal(r.status, 401);
    assert.equal(r.nextCalled, false);
  });

  it("ignores ?token= (tokens in URLs are not accepted on normal routes)", async () => {
    for (const t of [access(), media()]) {
      const r = await run(requireAuth, { query: { token: t } });
      assert.equal(r.status, 401);
      assert.equal(r.nextCalled, false);
    }
  });

  it("rejects a token whose tokenVersion was bumped (revoked)", async () => {
    users.u1.tokenVersion = 1;
    const r = await run(requireAuth, { bearer: access() });
    assert.equal(r.status, 401);
  });

  it("rejects a token for a deleted user", async () => {
    const r = await run(requireAuth, { bearer: signAccessToken("gone", "USER", 0) });
    assert.equal(r.status, 401);
  });

  it("rejects garbage and a missing header", async () => {
    assert.equal((await run(requireAuth, { bearer: "not.a.jwt" })).status, 401);
    assert.equal((await run(requireAuth, {})).status, 401);
  });
});

describe("requireMediaAuth (stream/cover routes)", () => {
  it("accepts ?token=<media token>", async () => {
    const r = await run(requireMediaAuth, { query: { token: media() } });
    assert.equal(r.nextCalled, true);
    assert.equal(r.user?.id, "u1");
  });

  it("accepts ?token=<access token> (older app builds)", async () => {
    const r = await run(requireMediaAuth, { query: { token: access() } });
    assert.equal(r.nextCalled, true);
  });

  it("rejects ?token=<refresh token>", async () => {
    const r = await run(requireMediaAuth, { query: { token: refresh() } });
    assert.equal(r.status, 401);
    assert.equal(r.nextCalled, false);
  });

  it("accepts a Bearer access token but not a Bearer media/refresh token", async () => {
    assert.equal((await run(requireMediaAuth, { bearer: access() })).nextCalled, true);
    assert.equal((await run(requireMediaAuth, { bearer: media() })).status, 401);
    assert.equal((await run(requireMediaAuth, { bearer: refresh() })).status, 401);
  });

  it("ignores array-valued ?token= (Express parses ?token=a&token=b as an array)", async () => {
    const r = await run(requireMediaAuth, { query: { token: [media(), media()] } });
    assert.equal(r.status, 401);
  });

  it("rejects a revoked media token", async () => {
    const t = media();
    users.u1.tokenVersion = 4;
    const r = await run(requireMediaAuth, { query: { token: t } });
    assert.equal(r.status, 401);
  });

  it("requires some token", async () => {
    const r = await run(requireMediaAuth, {});
    assert.equal(r.status, 401);
  });
});

describe("requireAdmin", () => {
  it("lets admins through and blocks users with 403", async () => {
    assert.equal((await run(requireAdmin, { user: { id: "a1", role: "ADMIN" } })).nextCalled, true);
    const r = await run(requireAdmin, { user: { id: "u1", role: "USER" } });
    assert.equal(r.status, 403);
    assert.equal(r.nextCalled, false);
  });
});
