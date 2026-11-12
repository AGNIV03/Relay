// Test environment. Import this FIRST in every test file (ESM evaluates imports
// in order, so it runs before lib/env.ts reads process.env).
//
// DATABASE_URL points at a closed loopback port on purpose: no test may touch a
// real database. Anything that accidentally queries fails loudly with ECONNREFUSED
// instead of reading or writing data.
process.env.JWT_SECRET = "test-only-jwt-secret-0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/relay_test";
process.env.NODE_ENV = "test";
process.env.SPOTIFY_CLIENT_ID = "";
process.env.SPOTIFY_CLIENT_SECRET = "";
