import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

// Prisma 7 dropped the Rust query engine: the client now connects through a
// driver adapter. DATABASE_URL is provided by docker-compose in production and
// from the repo-root .env (via --env-file / prisma.config.ts) in local dev.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });
