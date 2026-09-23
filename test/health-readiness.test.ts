import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ poolQuery: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ pool: { query: mock.poolQuery } }))

import { getReadiness } from "@/lib/health"

const originalEnv = { ...process.env }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.DB_HOST = "localhost"
  process.env.DB_USER = "user"
  process.env.DB_NAME = "db"
})

afterEach(() => {
  process.env = { ...originalEnv }
})

describe("readiness probe", () => {
  it("is ready when the database responds", async () => {
    mock.poolQuery.mockResolvedValue([[{ 1: 1 }]])
    const report = await getReadiness()
    expect(report.ok).toBe(true)
    expect(report.checks.database.ok).toBe(true)
    expect(report.checks.database.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("is NOT ready when the database is unreachable", async () => {
    mock.poolQuery.mockRejectedValue(Object.assign(new Error("nope"), { code: "ECONNREFUSED" }))
    const report = await getReadiness()
    expect(report.ok).toBe(false)
    expect(report.checks.database.ok).toBe(false)
    expect(report.checks.database.detail).toBe("ECONNREFUSED")
  })

  it("is NOT ready when the database is not configured", async () => {
    delete process.env.DB_HOST
    const report = await getReadiness()
    expect(report.ok).toBe(false)
    expect(report.checks.database.detail).toBe("Database is not configured")
    expect(mock.poolQuery).not.toHaveBeenCalled()
  })

  it("reports storage as configured when a backend env var is present", async () => {
    mock.poolQuery.mockResolvedValue([[{ 1: 1 }]])
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_token"
    const report = await getReadiness()
    expect(report.checks.storage.ok).toBe(true)
    // Storage never gates readiness — only the database does.
    delete process.env.BLOB_READ_WRITE_TOKEN
    const report2 = await getReadiness()
    expect(report2.checks.storage.ok).toBe(false)
    expect(report2.ok).toBe(true)
  })
})
