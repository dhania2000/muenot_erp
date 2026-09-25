import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec28 (#125) — Server-side maintenance store enforcement. The DB layer is
 * mocked so we can prove idempotent creation, cross-tenant 404 on end, and
 * that a tenant read pins `tenant_id` — never leaking another tenant's rows.
 */

const calls: { sql: string; params: any[] }[] = []
let results: any[] = []

vi.mock("@/lib/db", () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params })
    if (/CREATE\s+TABLE/i.test(sql)) return []
    return results.length ? results.shift() : []
  }),
}))

vi.mock("@/lib/audit-log-store", () => ({ recordAuditLog: vi.fn(async () => {}) }))

import {
  MaintenanceError,
  createWindow,
  endWindow,
  invalidateMaintenanceCache,
  listTenantWindows,
} from "@/lib/maintenance/store"
import type { WindowInput } from "@/lib/maintenance/model"

const platformInput: WindowInput = {
  scope: "platform",
  tenantId: null,
  moduleKey: null,
  title: "Database upgrade",
  message: "",
  startsAt: new Date("2026-06-01T13:00:00.000Z"),
  endsAt: null,
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 5,
    scope: "tenant",
    tenant_id: 7,
    module_key: null,
    title: "Workspace maintenance",
    message: "",
    starts_at: "2026-06-01 13:00:00",
    ends_at: null,
    status: "scheduled",
    ...over,
  }
}

beforeEach(() => {
  calls.length = 0
  results = []
  invalidateMaintenanceCache()
})

afterEach(() => vi.clearAllMocks())

describe("createWindow (idempotency)", () => {
  it("replays the original window on a repeated Idempotency-Key without inserting", async () => {
    results = [[row({ id: 42, scope: "platform", tenant_id: null })]] // prior lookup hits
    const { window, replayed } = await createWindow(platformInput, { userId: 1 }, "idem-key-123456")
    expect(replayed).toBe(true)
    expect(window.id).toBe(42)
    expect(calls.some((c) => /INSERT/i.test(c.sql))).toBe(false)
  })

  it("inserts a new window when the key has not been seen", async () => {
    results = [
      [], // prior lookup misses
      { insertId: 100 }, // INSERT
      [row({ id: 100, scope: "platform", tenant_id: null })], // re-read
    ]
    const { window, replayed } = await createWindow(platformInput, { userId: 1 }, "idem-key-654321")
    expect(replayed).toBe(false)
    expect(window.id).toBe(100)
    expect(calls.some((c) => /INSERT INTO `platform_maintenance_windows`/i.test(c.sql))).toBe(true)
  })
})

describe("endWindow (cross-tenant isolation)", () => {
  it("returns 404 without an UPDATE when the window belongs to another tenant", async () => {
    results = [[row({ id: 9, tenant_id: 7 })]] // getWindow finds tenant 7's window
    await expect(endWindow(9, "cancel", { userId: 1 }, 999)).rejects.toBeInstanceOf(MaintenanceError)
    expect(calls.some((c) => /UPDATE/i.test(c.sql))).toBe(false)
  })

  it("ends the caller's own tenant window", async () => {
    results = [
      [row({ id: 9, tenant_id: 7, status: "scheduled" })], // getWindow (pre)
      { affectedRows: 1 }, // UPDATE
      [row({ id: 9, tenant_id: 7, status: "completed" })], // getWindow (post)
    ]
    const w = await endWindow(9, "complete", { userId: 1 }, 7)
    expect(w.status).toBe("completed")
    expect(calls.some((c) => /UPDATE `platform_maintenance_windows`/i.test(c.sql))).toBe(true)
  })
})

describe("listTenantWindows (tenant scoping)", () => {
  it("always pins tenant_id to the caller's tenant", async () => {
    results = [[]]
    await listTenantWindows(7)
    const select = calls.find((c) => /SELECT \* FROM `platform_maintenance_windows` WHERE `tenant_id` = \?/i.test(c.sql))!
    expect(select).toBeTruthy()
    expect(select.params[0]).toBe(7)
  })
})
