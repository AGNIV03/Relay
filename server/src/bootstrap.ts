import bcrypt from "bcryptjs";
import { prisma } from "./lib/prisma.js";
import { env } from "./lib/env.js";

/**
 * On first boot (no users in the DB), create the initial admin account from
 * ADMIN_USERNAME / ADMIN_PASSWORD so you can log in immediately.
 */
export async function ensureFirstAdmin() {
  const count = await prisma.user.count();
  if (count > 0) return;
  await prisma.user.create({
    data: {
      username: env.adminUsername,
      passwordHash: await bcrypt.hash(env.adminPassword, 10),
      role: "ADMIN",
    },
  });
  console.log(
    `[bootstrap] created first admin "${env.adminUsername}". ` +
      `Log in and change the password / create more users from the web admin.`,
  );
}
