import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

/**
 * Test runner config for the tenant-isolation suite (, Phase 3/4).
 *
 * - `@/*` mirrors the tsconfig path alias so tests import app modules exactly
 *   as production code does.
 * - `server-only` is aliased to a no-op. That package throws when imported
 *   outside a React Server Component bundler; the isolation helpers guard real
 *   requests with it, but under Vitest we only exercise their pure logic.
 */
export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})
