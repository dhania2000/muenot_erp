import { defineConfig } from "vitest/config"

/**
 * E2E smoke suite: black-box HTTP tests against a running `next start` server
 * backed by a real MySQL database (see docs/ci.md). Kept separate from the
 * unit suite so `pnpm test` stays hermetic.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test-e2e/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
