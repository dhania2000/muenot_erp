import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ query: vi.fn(), warn: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ pool: { query: mock.query } }))
import { persistMonitorEvent } from "@/lib/system-monitoring"

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "warn").mockImplementation(mock.warn)
  mock.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT min_severity")) return [[{ min_severity: "WARNING" }]]
    if (sql.includes("INSERT INTO system_incidents")) return [{ insertId: 9 }]
    if (sql.includes("INSERT INTO system_logs")) return [{ insertId: 21 }]
    if (sql.includes("SELECT id, threshold_count")) return [[]]
    return [{ affectedRows: 1 }]
  })
})

describe("structured logger persistence", () => {
  it("never sends a nested token, password or raw SQL to storage", async () => {
    await persistMonitorEvent({ severity: "ERROR", service: "whatsapp", operation: "connection", errorCode: "TOKEN_PERSISTENCE_FAILED", message: "Authorization=Bearer hidden-token", metadata: { accessToken: "meta-token", password: "my-password", sql: "INSERT secret-value" } })
    const serialized = JSON.stringify(mock.query.mock.calls)
    for (const secret of ["hidden-token", "meta-token", "my-password", "secret-value"]) expect(serialized).not.toContain(secret)
    expect(serialized).toContain("TOKEN_PERSISTENCE_FAILED")
  })

  it("falls back safely when monitoring tables are unavailable and never recurses", async () => {
    mock.query.mockRejectedValue(Object.assign(new Error("DB password private-value"), { code: "ER_NO_SUCH_TABLE", sqlMessage: "private-value" }))
    await expect(persistMonitorEvent({ severity: "CRITICAL", service: "database", message: "Storage unavailable" })).resolves.toBeUndefined()
    expect(mock.query.mock.calls.length).toBeLessThan(4)
    expect(JSON.stringify(mock.warn.mock.calls)).not.toContain("private-value")
  })
})
