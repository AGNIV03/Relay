// Files refused at ingest (not audio, no playable audio, unsupported type...),
// recorded for the admin dashboard. Best-effort and capped to the newest KEEP rows.
import { prisma } from "../lib/prisma.js";

const KEEP = 500;
let pruneTimer: NodeJS.Timeout | null = null;

/** Record a rejected file. Fire-and-forget: never throws, never blocks ingest. */
export function recordRejection(
  name: string,
  reason: string,
  source: "upload" | "admin" | "scan",
  userId?: string | null,
): void {
  prisma.ingestRejection
    .create({
      data: { name: name.slice(0, 300), reason: reason.slice(0, 300), source, userId: userId ?? null },
    })
    .then(schedulePrune)
    .catch((e) => console.warn("[ingest] could not record rejection:", (e as Error).message));
}

// Coalesce a burst of rejections (a scan over a broken folder) into one prune.
function schedulePrune() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    void prune();
  }, 5_000);
  pruneTimer.unref();
}

async function prune() {
  try {
    const cutoff = await prisma.ingestRejection.findFirst({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: KEEP - 1,
      select: { createdAt: true },
    });
    if (cutoff) {
      await prisma.ingestRejection.deleteMany({ where: { createdAt: { lt: cutoff.createdAt } } });
    }
  } catch (e) {
    console.warn("[ingest] rejection prune failed:", (e as Error).message);
  }
}
