import { describe, it, expect } from "vitest"
import { getReportSource, type ReportSource } from "@/lib/reports/catalog"
import {
  aggregationsForType,
  columnAlias,
  operatorsForType,
  REPORT_CAPS,
  resolveDateRange,
  validateReportDefinition,
} from "@/lib/reports/model"

/**
 * SPEC 97 — Phase 4. The report builder turns arbitrary client JSON into a
 * normalized, allowlisted definition that the server query compiler can safely
 * turn into SQL. Every defence against unauthorized data exposure and expensive
 * queries lives in the pure model (`validateReportDefinition` + the caps), so
 * these tests pin the allowlisting, the type-aware operator/aggregation
 * vocabularies, the grouping/aggregation consistency rule, the safety caps and
 * the date-range resolution.
 */

const source = getReportSource("finance.invoices") as ReportSource

describe("catalog fixture", () => {
  it("has the columns the tests rely on", () => {
    expect(source).toBeTruthy()
    const keys = source.columns.map((c) => c.key)
    expect(keys).toEqual(expect.arrayContaining(["status", "total", "issue_date"]))
  })
})

// ---------------------------------------------------------------------------
// Type-aware vocabularies
// ---------------------------------------------------------------------------

describe("operatorsForType / aggregationsForType", () => {
  it("offers text operators for strings and range operators for numbers", () => {
    expect(operatorsForType("string")).toContain("contains")
    expect(operatorsForType("string")).not.toContain("between")
    expect(operatorsForType("number")).toContain("between")
    expect(operatorsForType("date")).toContain("before")
  })

  it("only offers sum/avg on numbers", () => {
    expect(aggregationsForType("number")).toEqual(
      expect.arrayContaining(["sum", "avg", "min", "max", "count", "count_distinct"]),
    )
    expect(aggregationsForType("string")).toEqual(["count", "count_distinct"])
    expect(aggregationsForType("date")).not.toContain("sum")
  })
})

// ---------------------------------------------------------------------------
// Validation — allowlisting and safety
// ---------------------------------------------------------------------------

describe("validateReportDefinition", () => {
  it("accepts a minimal valid definition", () => {
    const r = validateReportDefinition(source, {
      sourceKey: source.key,
      columns: [{ column: "invoice_number" }, { column: "total" }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.definition.columns).toHaveLength(2)
  })

  it("requires at least one column", () => {
    const r = validateReportDefinition(source, { columns: [] })
    expect(r.ok).toBe(false)
  })

  it("rejects an unknown column (allowlist)", () => {
    const r = validateReportDefinition(source, { columns: [{ column: "secret_column" }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(" ")).toContain("secret_column")
  })

  it("rejects columns absent from the live schema when availableColumnKeys is given", () => {
    const available = new Set(["invoice_number"]) // total not deployed
    const r = validateReportDefinition(
      source,
      { columns: [{ column: "invoice_number" }, { column: "total" }] },
      available,
    )
    expect(r.ok).toBe(false)
  })

  it("rejects an aggregation that the column type does not permit", () => {
    const r = validateReportDefinition(source, {
      columns: [{ column: "status", aggregation: "sum" }],
    })
    expect(r.ok).toBe(false)
  })

  it("requires plain columns to be grouped when any column is aggregated", () => {
    const bad = validateReportDefinition(source, {
      columns: [{ column: "status" }, { column: "total", aggregation: "sum" }],
    })
    expect(bad.ok).toBe(false)

    const good = validateReportDefinition(source, {
      columns: [{ column: "status" }, { column: "total", aggregation: "sum" }],
      groupBy: ["status"],
    })
    expect(good.ok).toBe(true)
  })

  it("rejects grouping without any aggregated column", () => {
    const r = validateReportDefinition(source, {
      columns: [{ column: "status" }],
      groupBy: ["status"],
    })
    expect(r.ok).toBe(false)
  })

  it("rejects a filter operator that the column type does not permit", () => {
    const r = validateReportDefinition(source, {
      columns: [{ column: "total" }],
      filters: [{ column: "total", operator: "contains", value: "x" }],
    })
    expect(r.ok).toBe(false)
  })

  it("requires a value for value-bearing filters and a second value for between", () => {
    const noValue = validateReportDefinition(source, {
      columns: [{ column: "total" }],
      filters: [{ column: "total", operator: "gt" }],
    })
    expect(noValue.ok).toBe(false)

    const noSecond = validateReportDefinition(source, {
      columns: [{ column: "total" }],
      filters: [{ column: "total", operator: "between", value: "1" }],
    })
    expect(noSecond.ok).toBe(false)
  })

  it("allows valueless operators with no value", () => {
    const r = validateReportDefinition(source, {
      columns: [{ column: "status" }],
      filters: [{ column: "status", operator: "is_empty" }],
    })
    expect(r.ok).toBe(true)
  })

  it("requires a sort target to be one of the selected output columns", () => {
    const bad = validateReportDefinition(source, {
      columns: [{ column: "total" }],
      sort: [{ column: "issue_date", direction: "asc" }],
    })
    expect(bad.ok).toBe(false)

    const good = validateReportDefinition(source, {
      columns: [{ column: "total" }, { column: "issue_date" }],
      sort: [{ column: "issue_date", direction: "desc" }],
    })
    expect(good.ok).toBe(true)
  })

  it("only accepts a date range on a date/datetime column", () => {
    const bad = validateReportDefinition(source, {
      columns: [{ column: "total" }],
      dateRange: { column: "total", preset: "this_month" },
    })
    expect(bad.ok).toBe(false)

    const good = validateReportDefinition(source, {
      columns: [{ column: "issue_date" }],
      dateRange: { column: "issue_date", preset: "this_month" },
    })
    expect(good.ok).toBe(true)
  })

  it("clamps the limit to the hard row cap", () => {
    const r = validateReportDefinition(source, {
      columns: [{ column: "total" }],
      limit: 10_000_000,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.definition.limit).toBe(REPORT_CAPS.maxRows)
  })

  it("enforces the max column / filter / group caps", () => {
    const tooMany = validateReportDefinition(source, {
      columns: Array.from({ length: REPORT_CAPS.maxColumns + 1 }, () => ({ column: "total" })),
    })
    expect(tooMany.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

describe("columnAlias", () => {
  it("keeps a plain column key and suffixes aggregations", () => {
    expect(columnAlias({ column: "total" })).toBe("total")
    expect(columnAlias({ column: "total", aggregation: "sum" })).toBe("total__sum")
  })
})

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

describe("resolveDateRange", () => {
  const now = new Date("2026-03-15T12:00:00Z")

  it("resolves a fixed preset to a half-open window", () => {
    expect(resolveDateRange("today", {}, now)).toEqual({ from: "2026-03-15", toExclusive: "2026-03-16" })
    expect(resolveDateRange("yesterday", {}, now)).toEqual({ from: "2026-03-14", toExclusive: "2026-03-15" })
    expect(resolveDateRange("this_month", {}, now)).toEqual({ from: "2026-03-01", toExclusive: "2026-04-01" })
    expect(resolveDateRange("this_year", {}, now)).toEqual({ from: "2026-01-01", toExclusive: "2027-01-01" })
  })

  it("resolves this_quarter to the containing quarter", () => {
    // March is in Q1 (Jan–Mar).
    expect(resolveDateRange("this_quarter", {}, now)).toEqual({ from: "2026-01-01", toExclusive: "2026-04-01" })
  })

  it("makes a custom end date inclusive by ending the window on the next day", () => {
    expect(resolveDateRange("custom", { from: "2026-01-01", to: "2026-01-31" }, now)).toEqual({
      from: "2026-01-01",
      toExclusive: "2026-02-01",
    })
  })

  it("returns null for a custom range missing its bounds", () => {
    expect(resolveDateRange("custom", {}, now)).toBeNull()
  })
})
