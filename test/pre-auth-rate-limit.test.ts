import { beforeEach, describe, expect, it, vi } from "vitest"

// the pre-auth limiter is now a shared, DB-backed store. These tests
// exercise it against an in-memory simulation of the MySQL row + FOR UPDATE
// transaction, plus the fail-open fallback when the store is unreachable.
const mock = vi.hoisted(() => ({
  query: vi.fn(),
  connQuery: vi.fn(),
  begin: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  release: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({
  query: mock.query,
  pool: {
    getConnection: async () => ({
      query: mock.connQuery,
      beginTransaction: mock.begin,
      commit: mock.commit,
      rollback: mock.rollback,
      release: mock.release,
    }),
  },
}))

import { checkRateLimit, prunePreAuthRateLimits } from "@/lib/rate-limit"

// bucket_key (params[0]) -> { window_reset_ms, request_count }
const rows = new Map<string, { window_reset_ms: number; request_count: number }>()

function installWorkingStore() {
  mock.query.mockResolvedValue([])
  mock.connQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.startsWith("INSERT")) {
      const key = String(params[0])
      if (!rows.has(key)) rows.set(key, { window_reset_ms: Number(params[1]), request_count: 0 })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith("SELECT")) {
      const row = rows.get(String(params[0]))
      return [row ? [row] : []]
    }
    if (sql.startsWith("UPDATE")) {
      // UPDATE ... SET window_reset_ms=?, request_count=? WHERE bucket_key=?
      rows.set(String(params[2]), { window_reset_ms: Number(params[0]), request_count: Number(params[1]) })
      return [{ affectedRows: 1 }]
    }
    return []
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  rows.clear()
  mock.commit.mockResolvedValue(undefined)
  mock.rollback.mockResolvedValue(undefined)
})

describe("shared pre-auth rate limiter", () => {
  it("allows requests up to the limit, then blocks the next one across calls", async () => {
    installWorkingStore()
    const opts = { max: 3, windowMs: 60_000 }
    for (let i = 0; i < 3; i++) {
      const result = await checkRateLimit("register:1.1.1.1", opts)
      expect(result.allowed).toBe(true)
    }
    const blocked = await checkRateLimit("register:1.1.1.1", opts)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
    expect(blocked.retryAfter).toBeGreaterThan(0)
  })

  it("shares one counter across distinct callers of the same key (cross-node consistency)", async () => {
    installWorkingStore()
    const opts = { max: 2, windowMs: 60_000 }
    // Simulates two application nodes hitting the same shared row.
    expect((await checkRateLimit("mobile-login:2.2.2.2:a@b.com", opts)).allowed).toBe(true)
    expect((await checkRateLimit("mobile-login:2.2.2.2:a@b.com", opts)).allowed).toBe(true)
    expect((await checkRateLimit("mobile-login:2.2.2.2:a@b.com", opts)).allowed).toBe(false)
  })

  it("keeps separate windows for different keys", async () => {
    installWorkingStore()
    const opts = { max: 1, windowMs: 60_000 }
    expect((await checkRateLimit("register:a", opts)).allowed).toBe(true)
    expect((await checkRateLimit("register:a", opts)).allowed).toBe(false)
    // A different key is unaffected.
    expect((await checkRateLimit("register:b", opts)).allowed).toBe(true)
  })

  it("resets the window once it expires", async () => {
    installWorkingStore()
    const opts = { max: 1, windowMs: 60_000 }
    expect((await checkRateLimit("register:c", opts)).allowed).toBe(true)
    expect((await checkRateLimit("register:c", opts)).allowed).toBe(false)
    // Force the stored window into the past so the next check starts fresh.
    for (const value of rows.values()) value.window_reset_ms = Date.now() - 1
    expect((await checkRateLimit("register:c", opts)).allowed).toBe(true)
  })

  it("fails open (allows) when the shared store is unreachable", async () => {
    mock.query.mockRejectedValue(new Error("db down"))
    mock.connQuery.mockRejectedValue(new Error("db down"))
    const result = await checkRateLimit("register:down", { max: 5, windowMs: 60_000 })
    expect(result.allowed).toBe(true)
  })

  it("prunes expired counters", async () => {
    mock.query.mockResolvedValue({ affectedRows: 4 })
    expect(await prunePreAuthRateLimits()).toBe(4)
  })
})
