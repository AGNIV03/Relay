// Rate-limit keying. clientIpKey is tested directly; the limiters are exercised
// through a throwaway Express app bound to 127.0.0.1 on an ephemeral port
// (loopback only, nothing leaves the machine).
import "./helpers/env.js";
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type Request } from "express";
import { clientIpKey, ipLimiter, userLimiter } from "../src/lib/rateLimit.js";

const req = (headers: Record<string, string>, ip?: string) => ({ headers, ip }) as unknown as Request;

describe("clientIpKey", () => {
  it("keys on CF-Connecting-IP (trimmed), ignoring a client-supplied X-Forwarded-For", () => {
    assert.equal(clientIpKey(req({ "cf-connecting-ip": " 203.0.113.7 ", "x-forwarded-for": "1.2.3.4" }, "10.0.0.1")), "203.0.113.7");
  });

  it("falls back to req.ip without the header (or with a blank one), else 'unknown'", () => {
    assert.equal(clientIpKey(req({}, "198.51.100.2")), "198.51.100.2");
    assert.equal(clientIpKey(req({ "cf-connecting-ip": "  " }, "198.51.100.2")), "198.51.100.2");
    assert.equal(clientIpKey(req({})), "unknown");
  });

  it("collapses IPv6 to its /56 so a client can't rotate through its own prefix", () => {
    const a = clientIpKey(req({ "cf-connecting-ip": "2001:db8:abcd:1200::1" }));
    const b = clientIpKey(req({ "cf-connecting-ip": "2001:db8:abcd:12ff:ffff::9" }));
    const c = clientIpKey(req({ "cf-connecting-ip": "2001:db8:abcd:1300::1" }));
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe("ipLimiter / userLimiter over HTTP (loopback)", () => {
  let server: Server;
  let base: string;

  before(async () => {
    const app = express();
    app.get("/ip", ipLimiter(60_000, 2), (_req, res) => res.json({ ok: true }));
    // Stand-in for requireAuth: the user id comes from a header.
    app.get(
      "/user",
      (r, _res, next) => {
        const u = r.headers["x-test-user"];
        if (typeof u === "string") r.user = { id: u, role: "USER" };
        next();
      },
      userLimiter(60_000, 2),
      (_req, res) => res.json({ ok: true }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const hit = (path: string, headers: Record<string, string>) =>
    fetch(base + path, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));

  it("limits per CF-Connecting-IP and returns the JSON error body", async () => {
    const ip = { "cf-connecting-ip": "203.0.113.50" };
    assert.equal((await hit("/ip", ip)).status, 200);
    assert.equal((await hit("/ip", ip)).status, 200);
    const third = await hit("/ip", ip);
    assert.equal(third.status, 429);
    assert.deepEqual(third.body, { error: "Too many requests. Please try again later." });
    // Another client IP has its own bucket; spoofing X-Forwarded-For doesn't help.
    assert.equal((await hit("/ip", { "cf-connecting-ip": "203.0.113.51" })).status, 200);
    assert.equal((await hit("/ip", { ...ip, "x-forwarded-for": "9.9.9.9" })).status, 429);
  });

  it("limits per user id regardless of IP", async () => {
    const u = (ip: string) => ({ "x-test-user": "user-a", "cf-connecting-ip": ip });
    assert.equal((await hit("/user", u("203.0.113.60"))).status, 200);
    assert.equal((await hit("/user", u("203.0.113.61"))).status, 200);
    assert.equal((await hit("/user", u("203.0.113.62"))).status, 429);
    assert.equal((await hit("/user", { "x-test-user": "user-b", "cf-connecting-ip": "203.0.113.62" })).status, 200);
  });
});
