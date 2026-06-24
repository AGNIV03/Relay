import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

// Prisma 7 no longer auto-loads .env. In local dev DATABASE_URL lives in the
// repo-root .env (shared by docker-compose and the server); in Docker it's
// already present in the environment, so this load just no-ops there.
config({ path: "../.env" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // Connection URL for Prisma Migrate (the runtime client connects via the
  // driver adapter in src/lib/prisma.ts).
  datasource: {
    url: env("DATABASE_URL"),
  },
});
