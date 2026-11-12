import "./helpers/env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  signAccessToken,
  signRefreshToken,
  signMediaToken,
  verifyToken,
  tokenVersionOf,
  type TokenPayload,
} from "../src/lib/jwt.js";

const SECRET = process.env.JWT_SECRET!;
const DAY = 24 * 60 * 60;
const nowSec = () => Math.floor(Date.now() / 1000);

describe("jwt sign/verify", () => {
  it("access token round-trips with type, role and token version", () => {
    const p = verifyToken(signAccessToken("u1", "ADMIN", 3));
    assert.equal(p.sub, "u1");
    assert.equal(p.role, "ADMIN");
    assert.equal(p.type, "access");
    assert.equal(p.tv, 3);
    assert.equal(p.jti, undefined);
    const ttl = p.exp! - nowSec();
    assert.ok(ttl > 29 * DAY && ttl <= 30 * DAY, `access ttl ${ttl}`);
  });

  it("refresh token carries its jti and a 365-day lifetime", () => {
    const p = verifyToken(signRefreshToken("u1", "USER", 0, "row-123"));
    assert.equal(p.type, "refresh");
    assert.equal(p.jti, "row-123");
    assert.equal(p.tv, 0);
    const ttl = p.exp! - nowSec();
    assert.ok(ttl > 364 * DAY && ttl <= 365 * DAY, `refresh ttl ${ttl}`);
  });

  it("media token is type media with a 7-day expiry matching expiresAt", () => {
    const { token, expiresAt } = signMediaToken("u2", "USER", 5);
    const p = verifyToken(token);
    assert.equal(p.type, "media");
    assert.equal(p.tv, 5);
    assert.ok(Math.abs(p.exp! * 1000 - expiresAt.getTime()) < 2000);
    const ttl = p.exp! - nowSec();
    assert.ok(ttl > 6 * DAY && ttl <= 7 * DAY, `media ttl ${ttl}`);
  });

  it("the three token types are distinguishable (no type confusion at the claim level)", () => {
    const types = [
      verifyToken(signAccessToken("u", "USER", 0)).type,
      verifyToken(signRefreshToken("u", "USER", 0, "j")).type,
      verifyToken(signMediaToken("u", "USER", 0).token).type,
    ];
    assert.deepEqual(types, ["access", "refresh", "media"]);
  });

  it("rejects a token signed with a different secret", () => {
    const forged = jwt.sign(
      { sub: "u1", role: "ADMIN", type: "access", tv: 0 },
      "some-other-secret-".repeat(3),
      { algorithm: "HS256" },
    );
    assert.throws(() => verifyToken(forged));
  });

  it("rejects a tampered payload", () => {
    const [h, , s] = signAccessToken("u1", "USER", 0).split(".");
    const evil = Buffer.from(JSON.stringify({ sub: "u1", role: "ADMIN", type: "access", tv: 0 })).toString(
      "base64url",
    );
    assert.throws(() => verifyToken(`${h}.${evil}.${s}`));
  });

  it("rejects alg=none and algorithms other than HS256 (algorithm pinning)", () => {
    const none = jwt.sign({ sub: "u1", role: "ADMIN", type: "access" }, "", { algorithm: "none" });
    assert.throws(() => verifyToken(none));
    const hs512 = jwt.sign({ sub: "u1", role: "ADMIN", type: "access" }, SECRET, { algorithm: "HS512" });
    assert.throws(() => verifyToken(hs512));
  });

  it("rejects an expired token", () => {
    const old = jwt.sign(
      { sub: "u1", role: "USER", type: "access", tv: 0, exp: nowSec() - 10 },
      SECRET,
      { algorithm: "HS256" },
    );
    assert.throws(() => verifyToken(old), /expired/);
  });

  it("tokenVersionOf treats a missing tv (pre-revocation tokens) as 0", () => {
    assert.equal(tokenVersionOf({ sub: "u", role: "USER", type: "access" } as TokenPayload), 0);
    assert.equal(tokenVersionOf({ sub: "u", role: "USER", type: "access", tv: 7 }), 7);
  });
});
