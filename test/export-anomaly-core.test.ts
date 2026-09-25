import { describe, expect, it } from "vitest"
import { type ExportAnomalyInput, assessExport } from "@/lib/export-anomaly-core"

function input(overrides: Partial<ExportAnomalyInput> = {}): ExportAnomalyInput {
  return {
    rowCount: overrides.rowCount ?? 10,
    isFullTenant: overrides.isFullTenant ?? false,
    recentExportCount: overrides.recentExportCount ?? 1,
    destination: overrides.destination ?? "download",
  }
}

describe("assessExport", () => {
  it("does not alert on a small, single, in-scope download", () => {
    const a = assessExport(input())
    expect(a.alert).toBe(false)
    expect(a.severity).toBe("info")
    expect(a.bulk).toBe(false)
    expect(a.unusual).toBe(false)
  })

  it("flags a bulk export by row count", () => {
    const a = assessExport(input({ rowCount: 5_000 }))
    expect(a.bulk).toBe(true)
    expect(a.alert).toBe(true)
    expect(a.reasons).toContain("row_count>=5000")
  })

  it("flags a full-tenant export as bulk regardless of row count", () => {
    const a = assessExport(input({ isFullTenant: true, rowCount: 3 }))
    expect(a.bulk).toBe(true)
    expect(a.reasons).toContain("full_tenant_scope")
  })

  it("flags an export burst by the same actor as unusual", () => {
    const a = assessExport(input({ recentExportCount: 5 }))
    expect(a.unusual).toBe(true)
    expect(a.alert).toBe(true)
    expect(a.reasons).toContain("export_burst>=5")
  })

  it("flags an external destination as unusual", () => {
    const a = assessExport(input({ destination: "external" }))
    expect(a.unusual).toBe(true)
    expect(a.reasons).toContain("external_destination")
  })

  it("escalates to critical when two or more signals combine", () => {
    const a = assessExport(input({ rowCount: 10_000, isFullTenant: true }))
    expect(a.severity).toBe("critical")
  })

  it("stays warning for a single signal", () => {
    const a = assessExport(input({ rowCount: 10_000 }))
    expect(a.severity).toBe("warning")
  })

  it("honors custom thresholds", () => {
    const a = assessExport(input({ rowCount: 100 }), { bulkRowCount: 50, burstCount: 3 })
    expect(a.bulk).toBe(true)
  })
})
