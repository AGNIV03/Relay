// A tiny in-memory stand-in for the handful of Prisma where-clause shapes the
// code under test uses (equality, null, { gt }, { lt }, { in }). Not a Prisma
// emulator: it supports exactly what lib/refreshTokens.ts and friends call.

type Row = Record<string, unknown>;

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function matches(row: Row, where: Row = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
    } else if (cond instanceof Date || typeof cond !== "object") {
      if (cond instanceof Date ? !(v instanceof Date) || cmp(v, cond) !== 0 : v !== cond) return false;
    } else {
      const c = cond as { gt?: unknown; lt?: unknown; in?: unknown[] };
      if ("gt" in c && (v === null || v === undefined || cmp(v, c.gt) <= 0)) return false;
      if ("lt" in c && (v === null || v === undefined || cmp(v, c.lt) >= 0)) return false;
      if ("in" in c && !c.in!.includes(v)) return false;
    }
  }
  return true;
}

/** Uniqueness violation shaped like Prisma's (code P2002). */
export class UniqueViolation extends Error {
  code = "P2002";
}

/** A fake model delegate over an array of rows keyed by `id`. */
export function fakeModel<T extends Row>(rows: T[] = []) {
  const calls: string[] = [];
  return {
    rows,
    calls,
    async create({ data }: { data: T }) {
      calls.push("create");
      if (rows.some((r) => r.id === data.id)) throw new UniqueViolation("unique");
      const row = { usedAt: null, revokedAt: null, ...data } as T;
      rows.push(row);
      return { ...row };
    },
    async findUnique({ where }: { where: Row }) {
      calls.push("findUnique");
      const r = rows.find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    async findFirst({ where }: { where?: Row } = {}) {
      calls.push("findFirst");
      const r = rows.find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    async updateMany({ where, data }: { where: Row; data: Partial<T> }) {
      calls.push("updateMany");
      let count = 0;
      for (const r of rows) {
        if (matches(r, where)) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    },
  };
}
