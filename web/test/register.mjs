// Loader hook for `node --test` on the web sources (no extra dependencies).
// Node strips the TypeScript types natively; this only teaches its resolver
// what the Next.js bundler does for us:
//   - the `@/` path alias (tsconfig "paths": "@/*" -> "./src/*")
//   - extensionless relative imports ("./types" -> "./types.ts")
// plus one test seam:
//   - `@/lib/api` resolves to test/stubs/api.ts. The real client uses TS syntax
//     Node can't strip (parameter properties) and talks to the network; modules
//     under test only import it for functions the tests don't call.
// Usage: node --import ./test/register.mjs --test "test/**/*.test.ts"
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);
const STUBS = { "@/lib/api": new URL("./stubs/api.ts", import.meta.url).href };
const HAS_EXT = /\.(?:[cm]?[jt]s|tsx|jsx|json|node)$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(STUBS, specifier)) return nextResolve(STUBS[specifier], context);
    let spec = specifier.startsWith("@/") ? new URL(specifier.slice(2), SRC).href : specifier;
    const local = spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:");
    if (local && !HAS_EXT.test(spec) && context.parentURL) {
      const base = new URL(spec, context.parentURL).href;
      for (const suffix of [".ts", "/index.ts"]) {
        if (existsSync(fileURLToPath(base + suffix))) {
          spec = base + suffix;
          break;
        }
      }
    }
    return nextResolve(spec, context);
  },
});
