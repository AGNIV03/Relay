// lib/env.ts: placeholder detection (pure) and the boot-time checks, which run
// at import time and so are exercised in a child process with a controlled env.
import "./helpers/env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isPlaceholderSecret } from "../src/lib/env.js";

const serverDir = fileURLToPath(new URL("..", import.meta.url));

function bootEnv(vars: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !["JWT_SECRET", "DATABASE_URL", "NODE_ENV"].includes(k)) env[k] = v;
  }
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) env[k] = v;
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", "await import('./src/lib/env.ts'); console.log('BOOTED')"],
    { cwd: serverDir, env, encoding: "utf8", timeout: 30_000 },
  );
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const DB = "postgresql://x:y@127.0.0.1:1/z";
const STRONG = "a".repeat(64);

describe("isPlaceholderSecret", () => {
  it("flags the .env.example values, case-insensitively", () => {
    assert.equal(isPlaceholderSecret("change-me-to-a-strong-password"), true);
    assert.equal(isPlaceholderSecret("CHANGE-ME"), true);
    assert.equal(isPlaceholderSecret("prefix-Change-Me-suffix"), true);
  });

  it("accepts real secrets", () => {
    assert.equal(isPlaceholderSecret("9f8e7d6c5b4a39281706f5e4d3c2b1a0"), false);
    assert.equal(isPlaceholderSecret("changeme"), false); // only the hyphenated marker
    assert.equal(isPlaceholderSecret(""), false);
  });
});

describe("env boot checks (child process)", () => {
  it("refuses to load without JWT_SECRET / DATABASE_URL", () => {
    const a = bootEnv({ DATABASE_URL: DB });
    assert.notEqual(a.code, 0);
    assert.match(a.out, /Missing required env var: JWT_SECRET/);
    const b = bootEnv({ JWT_SECRET: STRONG });
    assert.notEqual(b.code, 0);
    assert.match(b.out, /Missing required env var: DATABASE_URL/);
  });

  it("refuses a short or placeholder JWT secret in production", () => {
    const short = bootEnv({ JWT_SECRET: "short", DATABASE_URL: DB, NODE_ENV: "production" });
    assert.notEqual(short.code, 0);
    assert.match(short.out, /Refusing to start/);
    const placeholder = bootEnv({
      JWT_SECRET: "change-me-change-me-change-me-change-me-1234",
      DATABASE_URL: DB,
      NODE_ENV: "production",
    });
    assert.notEqual(placeholder.code, 0);
    assert.match(placeholder.out, /Refusing to start/);
  });

  it("only warns about a weak secret outside production", () => {
    const r = bootEnv({ JWT_SECRET: "short", DATABASE_URL: DB, NODE_ENV: "development" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /WARNING/);
    assert.match(r.out, /BOOTED/);
  });

  it("boots in production with a strong secret", () => {
    const r = bootEnv({ JWT_SECRET: STRONG, DATABASE_URL: DB, NODE_ENV: "production" });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /WARNING/);
  });
});
