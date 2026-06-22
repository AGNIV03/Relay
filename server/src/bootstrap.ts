import bcrypt from "bcryptjs";
import { prisma } from "./lib/prisma.js";
import { env } from "./lib/env.js";

/**
 * On first boot (no users in the DB), create the initial admin account from
 * ADMIN_USERNAME / ADMIN_PASSWORD so you can log in immediately.
 */
const WEAK_ADMIN_PASSWORDS = new Set(["admin", "password", "change-me", "changeme"]);

export async function ensureFirstAdmin() {
  const count = await prisma.user.count();
  if (count > 0) return;
  // Fail fast rather than ship a guessable admin on a fresh production deploy.
  if (process.env.NODE_ENV === "production") {
    const pw = env.adminPassword;
    if (!pw || pw.length < 10 || WEAK_ADMIN_PASSWORDS.has(pw.toLowerCase())) {
      throw new Error(
        "Refusing to seed the first admin with a weak/default ADMIN_PASSWORD. " +
          "Set a strong ADMIN_PASSWORD (>= 10 chars) in the environment.",
      );
    }
  }
  await prisma.user.create({
    data: {
      username: env.adminUsername,
      passwordHash: await bcrypt.hash(env.adminPassword, 12),
      role: "ADMIN",
    },
  });
  console.log(
    `[bootstrap] created first admin "${env.adminUsername}". ` +
      `Log in and change the password / create more users from the web admin.`,
  );
}
