import { describe, expect, it } from "vitest"
import {
  RETENTION_LIMITS,
  clampRetentionDays,
  computeNextRun,
  computeRetentionCutoff,
  describeRetentionDays,
  exceptionMatchesRecord,
  isBeyondRetention,
  isRecordExempt,
  isRunnable,
  normalizePolicyInput,
  parseRetentionPeriod,
  resolveRunState,
  toRetentionAction,
  toRetentionDays,
  toRetentionStatus,
} from "@/lib/retention-model"
import { getCatalogEntry, resolveTargetColumns, RETENTION_CATALOG } from "@/lib/retention-catalog"

/**
 * SPEC 71 — Phase 4. Pure, DB-free validation of the retention model: period
 * arithmetic and clamping, cutoff math, run-state precedence (legal hold always
 * wins), next-run scheduling, exception matching, request normalization, and
 * the catalog column-resolution that keeps the engine install-agnostic. Fixed
 * clocks keep every time-based assertion deterministic.
 */

// ---------------------------------------------------------------------------
// Period arithmetic
// ---------------------------------------------------------------------------

describe("clampRetentionDays", () => {
  it("clamps into the allowed whole-number range", () => {
    expect(clampRetentionDays(0)).toBe(RETENTION_LIMITS.MIN_DAYS)
    expect(clampRetentionDays(-5)).toBe(RETENTION_LIMITS.MIN_DAYS)
    expect(clampRetentionDays(10_000_000)).toBe(RETENTION_LIMITS.MAX_DAYS)
    expect(clampRetentionDays(90.9)).toBe(90)
    expect(clampRetentionDays("garbage" as unknown)).toBe(RETENTION_LIMITS.MIN_DAYS)
  })
})

describe("toRetentionDays", () => {
  it("converts value + unit into days", () => {
    expect(toRetentionDays(7, "years")).toBe(7 * 365)
    expect(toRetentionDays(18, "months")).toBe(18 * 30)
    expect(toRetentionDays(90, "days")).toBe(90)
  })
  it("defaults an unknown unit to years and floors bad values", () => {
    expect(toRetentionDays(2, "decades" as unknown)).toBe(2 * 365)
    expect(toRetentionDays(0, "years")).toBe(RETENTION_LIMITS.MIN_DAYS)
    expect(toRetentionDays(-3, "years")).toBe(RETENTION_LIMITS.MIN_DAYS)
  })
})

describe("parseRetentionPeriod", () => {
  it("parses common free-form period strings", () => {
    expect(parseRetentionPeriod("7 years")).toBe(7 * 365)
    expect(parseRetentionPeriod("10years")).toBe(10 * 365)
    expect(parseRetentionPeriod("18 months")).toBe(18 * 30)
    expect(parseRetentionPeriod("90 days")).toBe(90)
    expect(parseRetentionPeriod("5")).toBe(5) // bare number = days
    expect(parseRetentionPeriod(365)).toBe(365)
  })
  it("returns null for values it cannot understand", () => {
    expect(parseRetentionPeriod("forever")).toBeNull()
    expect(parseRetentionPeriod("")).toBeNull()
    expect(parseRetentionPeriod(null)).toBeNull()
    expect(parseRetentionPeriod("0 years")).toBeNull()
  })
})

describe("describeRetentionDays", () => {
  it("renders the friendliest whole unit", () => {
    expect(describeRetentionDays(365)).toBe("1 year")
    expect(describeRetentionDays(730)).toBe("2 years")
    expect(describeRetentionDays(90)).toBe("3 months")
    expect(describeRetentionDays(1)).toBe("1 day")
    expect(describeRetentionDays(45)).toBe("45 days")
  })
})

// ---------------------------------------------------------------------------
// Cutoff math
// ---------------------------------------------------------------------------

describe("retention cutoff", () => {
  const now = new Date("2026-09-23T00:00:00.000Z")

  it("computes the cutoff N days before now", () => {
    const cutoff = computeRetentionCutoff(30, now)
    expect(cutoff.toISOString()).toBe("2026-08-24T00:00:00.000Z")
  })

  it("flags records at or before the cutoff as beyond retention", () => {
    expect(isBeyondRetention("2020-01-01", 365, now)).toBe(true)
    expect(isBeyondRetention("2026-09-01", 365, now)).toBe(false)
    expect(isBeyondRetention(null, 365, now)).toBe(false)
    expect(isBeyondRetention("not-a-date", 365, now)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Run state & scheduling
// ---------------------------------------------------------------------------

describe("resolveRunState", () => {
  it("lets a legal hold override any status", () => {
    expect(resolveRunState("active", true)).toBe("held")
    expect(resolveRunState("paused", true)).toBe("held")
  })
  it("maps status when not held", () => {
    expect(resolveRunState("active", false)).toBe("active")
    expect(resolveRunState("paused", false)).toBe("paused")
  })
  it("only allows the job to act on active policies", () => {
    expect(isRunnable("active")).toBe(true)
    expect(isRunnable("paused")).toBe(false)
    expect(isRunnable("held")).toBe(false)
  })
})

describe("computeNextRun", () => {
  it("schedules the next 03:00 UTC boundary for active policies", () => {
    const now = new Date("2026-09-23T01:00:00.000Z")
    expect(computeNextRun("active", now)?.toISOString()).toBe("2026-09-23T03:00:00.000Z")
  })
  it("rolls to the next day when already past 03:00", () => {
    const now = new Date("2026-09-23T05:00:00.000Z")
    expect(computeNextRun("active", now)?.toISOString()).toBe("2026-09-24T03:00:00.000Z")
  })
  it("has no next run when paused or held", () => {
    expect(computeNextRun("paused")).toBeNull()
    expect(computeNextRun("held")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

describe("exception matching", () => {
  const record = { id: 42, fields: { region: "EU", status: "Closed" } }

  it("matches a specific record id", () => {
    expect(exceptionMatchesRecord({ type: "record", recordRef: "42" }, record)).toBe(true)
    expect(exceptionMatchesRecord({ type: "record", recordRef: "7" }, record)).toBe(false)
    expect(exceptionMatchesRecord({ type: "record", recordRef: null }, record)).toBe(false)
  })

  it("matches a field/value criteria", () => {
    expect(exceptionMatchesRecord({ type: "criteria", matchField: "region", matchValue: "EU" }, record)).toBe(true)
    expect(exceptionMatchesRecord({ type: "criteria", matchField: "region", matchValue: "US" }, record)).toBe(false)
    expect(exceptionMatchesRecord({ type: "criteria", matchField: "missing", matchValue: "x" }, record)).toBe(false)
  })

  it("treats any matching exception as exempting the record", () => {
    const exceptions = [
      { type: "record" as const, recordRef: "99" },
      { type: "criteria" as const, matchField: "status", matchValue: "Closed" },
    ]
    expect(isRecordExempt(exceptions, record)).toBe(true)
    expect(isRecordExempt([{ type: "record", recordRef: "1" }], record)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe("normalizePolicyInput", () => {
  it("normalizes a structured value + unit policy", () => {
    const p = normalizePolicyInput({
      module: "Finance",
      recordType: "Closed invoices",
      retentionValue: 10,
      retentionUnit: "years",
      action: "archive",
      catalogKey: "finance.sales_invoices",
    })
    expect(p.retentionDays).toBe(10 * 365)
    expect(p.action).toBe("archive")
    expect(p.catalogKey).toBe("finance.sales_invoices")
    expect(p.status).toBe("active")
  })

  it("accepts a free-form period string", () => {
    const p = normalizePolicyInput({ module: "CRM", recordType: "Lost leads", period: "2 years", action: "delete" })
    expect(p.retentionDays).toBe(2 * 365)
    // delete always implies purge (the row is gone regardless)
    expect(p.purgeAfterArchive).toBe(true)
  })

  it("requires module, record type and a valid period", () => {
    expect(() => normalizePolicyInput({ recordType: "x", period: "1 year" })).toThrow(/module/i)
    expect(() => normalizePolicyInput({ module: "x", period: "1 year" })).toThrow(/record type/i)
    expect(() => normalizePolicyInput({ module: "x", recordType: "y", period: "forever" })).toThrow(/period/i)
  })

  it("coerces unknown action/status to safe defaults", () => {
    expect(toRetentionAction("nuke")).toBe("archive")
    expect(toRetentionStatus("weird")).toBe("active")
  })
})

// ---------------------------------------------------------------------------
// Catalog resolution
// ---------------------------------------------------------------------------

describe("catalog", () => {
  it("exposes stable keys resolvable back to entries", () => {
    for (const entry of RETENTION_CATALOG) {
      expect(getCatalogEntry(entry.key)).toBe(entry)
    }
    expect(getCatalogEntry("nope")).toBeNull()
    expect(getCatalogEntry(null)).toBeNull()
  })

  it("resolves candidate columns against the actual schema", () => {
    const entry = getCatalogEntry("finance.sales_invoices")!
    const cols = new Set(["id", "tenant_id", "created_at", "status"])
    const res = resolveTargetColumns(entry, cols)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.target.primaryKey).toBe("id")
      expect(res.target.tenantColumn).toBe("tenant_id")
      // invoice_date/updated_at missing → falls back to created_at
      expect(res.target.dateColumn).toBe("created_at")
      expect(res.target.statusFilter?.column).toBe("status")
    }
  })

  it("reports a clear reason when the table or a required column is missing", () => {
    const entry = getCatalogEntry("finance.sales_invoices")!
    expect(resolveTargetColumns(entry, new Set()).ok).toBe(false)
    const noTenant = resolveTargetColumns(entry, new Set(["id", "created_at"]))
    expect(noTenant.ok).toBe(false)
    if (!noTenant.ok) expect(noTenant.reason).toMatch(/tenant/i)
  })

  it("drops the status filter when the column is absent", () => {
    const entry = getCatalogEntry("finance.sales_invoices")!
    const res = resolveTargetColumns(entry, new Set(["id", "tenant_id", "created_at"]))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.target.statusFilter).toBeNull()
  })
})
