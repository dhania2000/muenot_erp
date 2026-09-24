import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Zero-violation audit + enforce rollout gate.
 * ---------------------------------------------------------------------------
 * The DB layer is mocked with a scenario router so we can prove the audit's
 * blocking rules without a live MySQL: a clean schema is ready for enforce, and
 * any single class of violation (NULL stamp, orphan row, missing column, missing
 * index) makes it not ready and makes assertReadyForEnforce throw.
 */

type Scenario = {
  exists: boolean
  hasColumn: boolean
  hasIndex: boolean
  hasFk: boolean
  totalRows: number
  nullRows: number
  orphanRows: number
}

let scenario: Scenario

vi.mock("@/lib/db", () => ({
  query: vi.fn(async (sql: string) => {
    const s = sql.toLowerCase()
    // Schema probes.
    if (s.includes("information_schema.tables")) return [{ n: scenario.exists ? 1 : 0 }]
    if (s.includes("information_schema.columns")) return [{ n: scenario.hasColumn ? 1 : 0 }]
    if (s.includes("information_schema.statistics")) return [{ n: scenario.hasIndex ? 1 : 0 }]
    if (s.includes("information_schema.key_column_usage")) return [{ n: scenario.hasFk ? 1 : 0 }]
    // Data probes (order matters: orphan before null before total).
    if (s.includes("left join")) return [{ n: scenario.orphanRows }]
    if (s.includes("is null")) return [{ n: scenario.nullRows }]
    if (s.includes("count(*)")) return [{ n: scenario.totalRows }]
    return []
  }),
}))

// Keep the audit fast + deterministic by exercising a small owned-table set.
vi.mock("@/lib/tenant-tables", () => ({
  TENANT_COLUMN: "tenant_id",
  TENANT_OWNED_TABLES: ["sales_leads", "clients"],
}))

function cleanScenario(): Scenario {
  return { exists: true, hasColumn: true, hasIndex: true, hasFk: true, totalRows: 10, nullRows: 0, orphanRows: 0 }
}

describe("tenant isolation audit", () => {
  beforeEach(() => {
    scenario = cleanScenario()
    delete process.env.TENANT_ISOLATION_MODE
  })
  afterEach(() => vi.clearAllMocks())

  it("reports clean + ready for enforce when schema and data are isolated", async () => {
    const { auditTenantIsolation } = await import("@/lib/tenant-isolation-audit")
    const report = await auditTenantIsolation()
    expect(report.clean).toBe(true)
    expect(report.readyForEnforce).toBe(true)
    expect(report.totals.nullTenantRows).toBe(0)
    expect(report.totals.orphanTenantRows).toBe(0)
    expect(report.tables.every((t) => t.clean)).toBe(true)
  })

  it("flags NULL tenant stamps as a blocking violation", async () => {
    scenario.nullRows = 3
    const { auditTenantIsolation } = await import("@/lib/tenant-isolation-audit")
    const report = await auditTenantIsolation()
    expect(report.clean).toBe(false)
    expect(report.readyForEnforce).toBe(false)
    expect(report.totals.nullTenantRows).toBe(6) // 3 per table x 2 tables
    expect(report.tables[0].violations.join(" ")).toMatch(/NULL tenant_id/i)
  })

  it("flags orphaned tenant references as a blocking violation", async () => {
    scenario.orphanRows = 2
    const { auditTenantIsolation } = await import("@/lib/tenant-isolation-audit")
    const report = await auditTenantIsolation()
    expect(report.clean).toBe(false)
    expect(report.tables[0].violations.join(" ")).toMatch(/non-existent tenant/i)
  })

  it("flags a missing tenant_id column and skips row counting", async () => {
    scenario.hasColumn = false
    const { auditTenantIsolation } = await import("@/lib/tenant-isolation-audit")
    const report = await auditTenantIsolation()
    expect(report.clean).toBe(false)
    expect(report.totals.missingColumn).toBe(2)
    expect(report.tables[0].violations.join(" ")).toMatch(/missing tenant_id column/i)
  })

  it("flags a missing leading tenant index but a missing FK is only a warning", async () => {
    scenario.hasIndex = false
    scenario.hasFk = false
    const { auditTenantIsolation } = await import("@/lib/tenant-isolation-audit")
    const report = await auditTenantIsolation()
    expect(report.clean).toBe(false) // missing index blocks
    expect(report.totals.missingIndex).toBe(2)
    expect(report.tables[0].warnings.join(" ")).toMatch(/foreign key/i)
  })

  it("treats an absent table as present:false and non-blocking", async () => {
    scenario.exists = false
    const { auditTenantIsolation } = await import("@/lib/tenant-isolation-audit")
    const report = await auditTenantIsolation()
    expect(report.clean).toBe(true)
    expect(report.totals.tablesPresent).toBe(0)
  })

  it("assertReadyForEnforce resolves on a clean audit", async () => {
    const { assertReadyForEnforce } = await import("@/lib/tenant-isolation-audit")
    const report = await assertReadyForEnforce()
    expect(report.readyForEnforce).toBe(true)
  })

  it("assertReadyForEnforce throws IsolationNotReadyError on violations", async () => {
    scenario.nullRows = 1
    const { assertReadyForEnforce, IsolationNotReadyError } = await import("@/lib/tenant-isolation-audit")
    await expect(assertReadyForEnforce()).rejects.toBeInstanceOf(IsolationNotReadyError)
  })
})
