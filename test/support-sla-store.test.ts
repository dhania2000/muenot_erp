import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec28 (#127) — The SLA breach sweep persists a breach for each running
 * clock past its deadline, firing exactly once per clock. The `= 0` UPDATE
 * guard makes a concurrent double-run harmless. DB layer mocked.
 */

const calls: { sql: string; params: any[] }[] = []
let results: any[] = []

vi.mock("@/lib/db", () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params })
    if (/CREATE\s+TABLE|INSERT\s+IGNORE/i.test(sql)) return []
    return results.length ? results.shift() : []
  }),
}))

vi.mock("@/lib/audit-log-store", () => ({ recordAuditLog: vi.fn(async () => {}) }))

import { sweepSlaBreaches } from "@/lib/support-sla/store"

beforeEach(() => {
  calls.length = 0
  results = []
})

afterEach(() => vi.clearAllMocks())

describe("sweepSlaBreaches", () => {
  it("counts a breach only when the guarded UPDATE actually flips the flag", async () => {
    results = [
      // response clock: one overdue ticket, UPDATE wins the race
      [{ id: 1, tenant_id: 7, reference: "SUP-1" }],
      { affectedRows: 1 },
      {}, // breach event INSERT
      // resolution clock: one candidate, but a concurrent run already flagged it
      [{ id: 1, tenant_id: 7, reference: "SUP-1" }],
      { affectedRows: 0 },
    ]
    const breached = await sweepSlaBreaches()
    expect(breached).toBe(1)
    // Exactly one breach event was written (for the response clock).
    const events = calls.filter((c) => /INSERT INTO `platform_support_ticket_events`/i.test(c.sql))
    expect(events).toHaveLength(1)
    expect(events[0].sql).toContain("sla_breach")
    // Every breach UPDATE re-asserts the `= 0` guard and the tenant scope.
    const updates = calls.filter((c) => /UPDATE `platform_support_tickets`/i.test(c.sql))
    expect(updates).toHaveLength(2)
    for (const u of updates) expect(u.params).toContain(7)
  })

  it("does nothing when no clocks are overdue", async () => {
    results = [[], []] // both clock SELECTs return no rows
    expect(await sweepSlaBreaches()).toBe(0)
    expect(calls.some((c) => /INSERT INTO `platform_support_ticket_events`/i.test(c.sql))).toBe(false)
  })
})
