import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "./lib/env.js";
import { ensureFirstAdmin } from "./bootstrap.js";

import authRoutes from "./routes/auth.js";
import libraryRoutes from "./routes/library.js";
import streamRoutes from "./routes/stream.js";
import searchRoutes from "./routes/search.js";
import playlistRoutes from "./routes/playlists.js";
import adminRoutes from "./routes/admin.js";
import socialRoutes from "./routes/social.js";
import chorusRoutes from "./routes/chorus.js";

const app = express();

// Behind Cloudflare + cloudflared + the Next.js /api proxy. Trust the proxy chain
// so req.ip reflects the forwarded client IP (used for rate limiting).
app.set("trust proxy", true);

// Security headers. CSP / Cross-Origin-Resource-Policy are intentionally left off
// here — the web app owns the page CSP, and it proxies media same-origin, while
// native apps fetch directly; a CORP/CSP on the API would break those. This still
// adds nosniff, X-Frame-Options: DENY, HSTS, Referrer-Policy, etc.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

// CORS: the web calls the API same-origin (via its own /api proxy) and native
// apps send no Origin header, so cross-origin browser access is only granted to
// explicitly allow-listed origins (CORS_ORIGINS, comma-separated). Unknown
// browser origins are denied.
const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      // No Origin = native app / curl / same-origin server hop → allow.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  }),
);

app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Brute-force protection on credential endpoints (Cloudflare is the edge limiter;
// this is in-app defense-in-depth). Keyed on CF-Connecting-IP: the Cloudflare
// tunnel always overwrites it with the real client IP, whereas X-Forwarded-For
// (what req.ip derives from with `trust proxy` on) can be prefixed by the client,
// letting an attacker rotate keys per request. req.ip is the fallback for direct
// (non-tunnel) dev access. A custom keyGenerator also skips the library's
// permissive-trust-proxy check, so no `validate` override is needed. Per-username
// backoff lives in routes/auth.ts.
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const cf = req.headers["cf-connecting-ip"];
    const client = typeof cf === "string" && cf.trim() ? cf.trim() : (req.ip ?? "unknown");
    return ipKeyGenerator(client); // collapses IPv6 to its /56 so it can't rotate addresses
  },
  message: { error: "Too many attempts — please try again later." },
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/refresh", authLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/library", libraryRoutes);
app.use("/api/stream", streamRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/playlists", playlistRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/social", socialRoutes);
app.use("/api/chorus", chorusRoutes);

// Fallback error handler. Express 5 forwards rejected async-handler promises here
// natively, so async failures return 500 instead of hanging the socket. Never
// leaks internals to the client.
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[error]", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  },
);

async function main() {
  await ensureFirstAdmin();
  const server = app.listen(env.port, () => {
    console.log(`[server] listening on http://localhost:${env.port}`);
    console.log(`[server] music path: ${env.musicPath}`);
  });
  // Audio is streamed over long-lived connections that the client paces to
  // playback (it reads ahead, then idles). Node's default 5-minute requestTimeout
  // would abort such a connection mid-track; disable it so streams aren't cut.
  // Keep-alive is also lengthened so reused sockets aren't dropped between reads.
  server.requestTimeout = 0;
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 0;
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
