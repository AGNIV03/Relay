import express from "express";
import cors from "cors";
import { env } from "./lib/env.js";
import { ensureFirstAdmin } from "./bootstrap.js";

import authRoutes from "./routes/auth.js";
import libraryRoutes from "./routes/library.js";
import streamRoutes from "./routes/stream.js";
import searchRoutes from "./routes/search.js";
import playlistRoutes from "./routes/playlists.js";
import adminRoutes from "./routes/admin.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/library", libraryRoutes);
app.use("/api/stream", streamRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/playlists", playlistRoutes);
app.use("/api/admin", adminRoutes);

// Fallback error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[error]", err);
    res.status(500).json({ error: "Internal server error" });
  },
);

async function main() {
  await ensureFirstAdmin();
  app.listen(env.port, () => {
    console.log(`[server] listening on http://localhost:${env.port}`);
    console.log(`[server] music path: ${env.musicPath}`);
  });
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
