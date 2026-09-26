import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ query: vi.fn(), expiries: vi.fn() }))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: m.query }))
vi.mock("@/lib/expiry/service", () => ({ getClassifiedExpiries: m.expiries }))

import {
  computeRiskComplianceDashboard,
  summarize,
  maskDashboard,
  severityFromCount,
  isStale,
  type SourceResult,
  type RiskScope,
} from "@/lib/risk-compliance/aggregate"

beforeEach(() => {
  m.query.mockReset()
  m.expiries.mockReset()
  m.expiries.mockResolvedValue([])
})

/**
 * Mock the DB so that only the tables listed in `columns` "exist"; everything
 * else probes empty and its source degrades to unavailable. `rows` supplies the
 * item/aggregate result for a source keyed by a `FROM <table>` fragment.
 */
function mockDb(columns: Record<string, string[]>, rows: Record<string, any[]> = {}) {
  m.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("information_schema.COLUMNS")) {
      const table = String(params[0])
      const cols = columns[table]
      return cols ? cols.map((c) => ({ c })) : []
    }
    const key = Object.keys(rows).find((frag) => sql.includes(`FROM ${frag}`))
    const data = key ? rows[key] : []
    if (sql.startsWith("SELECT COUNT(*)")) {
      return [{ c: data.length, m: data[0]?.created_at ?? data[0]?.updated_at ?? null }]
    }
    return data
  })
}

const GROUP: RiskScope = { level: "group", value: null }

describe("computeRiskComplianceDashboard — missing source modules", () => {
  it("reports every absent source as unavailable without throwing", async () => {
    mockDb({}) // no tables exist at all
    const dash = await computeRiskComplianceDashboard(7, GROUP)
    expect(dash.sources).toHaveLength(13)
    expect(dash.totals.sourcesMissing).toBe(13)
    expect(dash.totals.sourcesAvailable).toBe(0)
    expect(dash.totals.openItems).toBe(0)
    for (const s of dash.sources) {
      expect(s.available).toBe(false)
      expect(s.note).toMatch(/not installed/i)
      // A missing-module note must never leak raw SQL text.
      expect(s.note).not.toMatch(/SELECT|information_schema/i)
    }
  })
})

describe("computeRiskComplianceDashboard — tenant scope", () => {
  it("always filters failed-auth by the guard's tenant, never tenant-less rows", async () => {
    mockDb(
      { audit_log_entries: ["id", "tenant_id", "result", "action", "actor_email", "ip_address", "created_at"] },
      { "audit_log_entries t": [{ id: 1, action: "auth.login", actor_email: "a@x.com", ip_address: "1.1.1.1", created_at: "2027-02-10T00:00:00Z" }] },
    )
    const dash = await computeRiskComplianceDashboard(9, GROUP)
    const auth = dash.sources.find((s) => s.key === "failed_auth")!
    expect(auth.available).toBe(true)
    expect(auth.count).toBe(1)

    const dataCalls = m.query.mock.calls.filter(([sql]) => String(sql).includes("FROM audit_log_entries"))
    expect(dataCalls.length).toBeGreaterThan(0)
    for (const [sql, params] of dataCalls) {
      expect(String(sql)).toContain("t.tenant_id = ?")
      expect((params as unknown[])[0]).toBe(9) // strict tenant match
    }
  })
})

describe("computeRiskComplianceDashboard — dimensional withholding", () => {
  it("withholds a source that cannot filter by the requested dimension", async () => {
    mockDb({ maker_checker_changes: ["id", "tenant_id", "status", "title", "module_key", "entity_ref", "maker_name", "created_at"] })
    const dash = await computeRiskComplianceDashboard(7, { level: "company", value: "Acme" })
    const mcc = dash.sources.find((s) => s.key === "maker_checker")!
    expect(mcc.available).toBe(true)
    expect(mcc.withheld).toBe(true)
    expect(mcc.count).toBe(0)
    expect(mcc.items).toHaveLength(0)
    expect(dash.totals.sourcesWithheld).toBeGreaterThanOrEqual(1)
    // A withheld source must not run a data query that could leak org-wide rows.
    expect(m.query.mock.calls.some(([sql]) => String(sql).includes("FROM maker_checker_changes"))).toBe(false)
  })
})

// --- pure helpers -----------------------------------------------------------

describe("severityFromCount", () => {
  it("maps counts to severities with the given thresholds", () => {
    expect(severityFromCount(0)).toBe("ok")
    expect(severityFromCount(1)).toBe("medium")
    expect(severityFromCount(3)).toBe("high")
    expect(severityFromCount(10)).toBe("critical")
    expect(severityFromCount(5, 20, 5)).toBe("high")
  })
})

function source(over: Partial<SourceResult>): SourceResult {
  return {
    key: "k",
    label: "Src",
    category: "operational",
    available: true,
    scopeApplied: false,
    withheld: false,
    count: 0,
    severity: "ok",
    asOf: null,
    drillHref: "/x",
    items: [],
    ...over,
  }
}

describe("summarize", () => {
  it("rolls up totals and per-category counts", () => {
    const dash = summarize(7, GROUP, [
      source({ key: "a", category: "operational", available: true, count: 5, severity: "critical" }),
      source({ key: "b", category: "finance", available: true, count: 2, severity: "high" }),
      source({ key: "c", category: "hr", available: false, severity: "ok", note: "missing" }),
      source({ key: "d", category: "contracts", available: true, withheld: true, count: 0 }),
    ])
    expect(dash.totals).toMatchObject({ openItems: 7, critical: 1, high: 1, sourcesAvailable: 2, sourcesMissing: 1, sourcesWithheld: 1 })
    expect(dash.categories.operational).toEqual({ openItems: 5, critical: 1, sources: 1 })
    expect(dash.categories.finance).toEqual({ openItems: 2, critical: 0, sources: 1 })
    expect(dash.masked).toBe(false)
    expect(dash.scopeKey).toBe("group")
  })
})

describe("maskDashboard — sensitive export masking", () => {
  it("masks sensitive fields and scrubs their values from label/detail", () => {
    const dash = summarize(7, GROUP, [
      source({
        key: "payments",
        category: "finance",
        count: 1,
        items: [
          {
            id: "p1",
            label: "Payment to Acme Corp",
            detail: "Reversed for Acme Corp",
            severity: "high",
            amount: 1000,
            occurredAt: null,
            sensitive: { party: "Acme Corp" },
          },
        ],
      }),
    ])
    const masked = maskDashboard(dash)
    const it0 = masked.sources[0].items[0]
    expect(masked.masked).toBe(true)
    expect(it0.sensitive).toEqual({ party: expect.stringMatching(/masked/) })
    expect(it0.label).not.toContain("Acme Corp")
    expect(it0.detail).not.toContain("Acme Corp")
    expect(it0.label).toMatch(/masked/)
    // The original dashboard is not mutated.
    expect(dash.sources[0].items[0].label).toBe("Payment to Acme Corp")
    expect(dash.masked).toBe(false)
  })

  it("leaves items without sensitive data untouched", () => {
    const dash = summarize(7, GROUP, [source({ items: [{ id: "x", label: "Job failed", severity: "high", occurredAt: null }] })])
    const masked = maskDashboard(dash)
    expect(masked.sources[0].items[0].label).toBe("Job failed")
  })
})

describe("isStale", () => {
  it("is fresh within, stale beyond, and true for garbage timestamps", () => {
    const now = Date.now()
    expect(isStale(new Date(now - 60_000).toISOString(), 15 * 60_000, now)).toBe(false)
    expect(isStale(new Date(now - 20 * 60_000).toISOString(), 15 * 60_000, now)).toBe(true)
    expect(isStale("not-a-date", 15 * 60_000, now)).toBe(true)
  })
})
