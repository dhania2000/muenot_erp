import { describe, expect, it } from "vitest"
import {
  DEFAULT_MONTHLY_CAPACITY_HOURS,
  UTILIZATION_TARGET_PERCENT,
  allocatedHoursForPeriod,
  computeUtilizationMetrics,
  summarizeUtilization,
  type AllocationRecord,
  type UtilizationRow,
} from "@/lib/operations-utilization"

/**
 * SPEC 149 — Phase 4. Pure, DB-free validation that the Resource Utilization
 * metrics reconcile to the underlying timesheet numbers. Every calculation is
 * exercised directly against known hour inputs so the report can be trusted to
 * match approved timesheets exactly.
 */

function row(over: Partial<UtilizationRow> & { resource_id: string; period: string }): UtilizationRow {
  const metrics = computeUtilizationMetrics({
    availableHours: over.availableHours ?? 160,
    allocatedHours: over.allocatedHours ?? 0,
    actualHours: over.actualHours ?? 0,
    billableHours: over.billableHours ?? 0,
  })
  return {
    resource_name: over.resource_name ?? over.resource_id,
    ...metrics,
    resource_id: over.resource_id,
    period: over.period,
  }
}

describe("computeUtilizationMetrics", () => {
  it("derives every metric from raw timesheet hours", () => {
    const m = computeUtilizationMetrics({
      availableHours: 160,
      allocatedHours: 120,
      actualHours: 120,
      billableHours: 90,
    })
    // Actual ÷ Available
    expect(m.utilizationPercent).toBe(75)
    // Billable ÷ Available
    expect(m.billableUtilizationPercent).toBe(56.25)
    // Allocated ÷ Available
    expect(m.allocationPercent).toBe(75)
    // Billable ÷ Actual
    expect(m.billablePercent).toBe(75)
    // Available − Actual
    expect(m.varianceHours).toBe(40)
    // Actual − Billable
    expect(m.nonBillableHours).toBe(30)
    expect(m.status).toBe("Optimal")
  })

  it("reconciles billable + non-billable back to actual hours", () => {
    const m = computeUtilizationMetrics({
      availableHours: 160,
      allocatedHours: 0,
      actualHours: 137.5,
      billableHours: 101.25,
    })
    expect(m.billableHours + m.nonBillableHours).toBe(m.actualHours)
  })

  it("clamps negatives to zero", () => {
    const m = computeUtilizationMetrics({
      availableHours: -10,
      allocatedHours: -5,
      actualHours: -8,
      billableHours: -2,
    })
    expect(m.availableHours).toBe(0)
    expect(m.allocatedHours).toBe(0)
    expect(m.actualHours).toBe(0)
    expect(m.billableHours).toBe(0)
  })

  it("caps billable at actual so billable% never exceeds 100", () => {
    const m = computeUtilizationMetrics({
      availableHours: 160,
      allocatedHours: 0,
      actualHours: 100,
      billableHours: 130, // timesheet anomaly: more billable than logged
    })
    expect(m.billableHours).toBe(100)
    expect(m.nonBillableHours).toBe(0)
    expect(m.billablePercent).toBe(100)
  })

  it("never returns NaN/Infinity when available hours are zero", () => {
    const m = computeUtilizationMetrics({
      availableHours: 0,
      allocatedHours: 40,
      actualHours: 20,
      billableHours: 10,
    })
    expect(m.utilizationPercent).toBe(0)
    expect(m.allocationPercent).toBe(0)
    expect(m.status).toBe("No Capacity")
  })

  it("classifies status bands from the utilization target", () => {
    expect(computeUtilizationMetrics({ availableHours: 160, allocatedHours: 0, actualHours: 0, billableHours: 0 }).status).toBe("Idle")
    expect(computeUtilizationMetrics({ availableHours: 160, allocatedHours: 0, actualHours: 80, billableHours: 0 }).status).toBe("Under-utilized")
    expect(computeUtilizationMetrics({ availableHours: 160, allocatedHours: 0, actualHours: 180, billableHours: 0 }).status).toBe("Over-allocated")
    // Exactly at target = Optimal
    const atTarget = (UTILIZATION_TARGET_PERCENT / 100) * 160
    expect(computeUtilizationMetrics({ availableHours: 160, allocatedHours: 0, actualHours: atTarget, billableHours: 0 }).status).toBe("Optimal")
  })
})

describe("allocatedHoursForPeriod", () => {
  const period = "2026-03" // March 2026: 2026-03-01 .. 2026-03-31

  it("uses explicit allocated_capacity when present", () => {
    const allocations: AllocationRecord[] = [{ allocated_capacity: 40, from_date: "2026-03-01", to_date: "2026-03-31" }]
    expect(allocatedHoursForPeriod(allocations, period, 160)).toBe(40)
  })

  it("derives hours from allocation_percent × available capacity", () => {
    const allocations: AllocationRecord[] = [{ allocation_percent: 50, from_date: "2026-03-01", to_date: "2026-03-31" }]
    expect(allocatedHoursForPeriod(allocations, period, 160)).toBe(80)
  })

  it("sums overlapping allocations and ignores non-overlapping ones", () => {
    const allocations: AllocationRecord[] = [
      { allocated_capacity: 30, from_date: "2026-02-01", to_date: "2026-03-15" }, // overlaps
      { allocated_capacity: 20, from_date: "2026-03-20", to_date: "2026-04-10" }, // overlaps
      { allocated_capacity: 99, from_date: "2026-05-01", to_date: "2026-05-31" }, // no overlap
    ]
    expect(allocatedHoursForPeriod(allocations, period, 160)).toBe(50)
  })

  it("treats an allocation with no dates as always active", () => {
    const allocations: AllocationRecord[] = [{ allocated_capacity: 25 }]
    expect(allocatedHoursForPeriod(allocations, period, 160)).toBe(25)
  })

  it("returns 0 for a malformed period", () => {
    expect(allocatedHoursForPeriod([{ allocated_capacity: 40 }], "March", 160)).toBe(0)
  })
})

describe("summarizeUtilization", () => {
  it("returns an empty summary for no rows", () => {
    const s = summarizeUtilization([])
    expect(s.resourceCount).toBe(0)
    expect(s.rowCount).toBe(0)
    expect(s.availableHours).toBe(0)
    expect(s.utilizationPercent).toBe(0)
  })

  it("rolls per-resource rows into portfolio totals that reconcile to timesheets", () => {
    const rows = [
      row({ resource_id: "r1", period: "2026-03", availableHours: 160, allocatedHours: 160, actualHours: 160, billableHours: 120 }),
      row({ resource_id: "r2", period: "2026-03", availableHours: 160, allocatedHours: 80, actualHours: 80, billableHours: 40 }),
    ]
    const s = summarizeUtilization(rows)
    expect(s.resourceCount).toBe(2)
    expect(s.rowCount).toBe(2)
    expect(s.availableHours).toBe(320)
    expect(s.allocatedHours).toBe(240)
    expect(s.actualHours).toBe(240) // 160 + 80, matches summed timesheet hours
    expect(s.billableHours).toBe(160) // 120 + 40
    expect(s.utilizationPercent).toBe(75) // 240 / 320
    expect(s.billablePercent).toBe(66.67) // 160 / 240
  })

  it("counts distinct resources across multiple periods", () => {
    const rows = [
      row({ resource_id: "r1", period: "2026-02", actualHours: 100 }),
      row({ resource_id: "r1", period: "2026-03", actualHours: 120 }),
      row({ resource_id: "r2", period: "2026-03", actualHours: 60 }),
    ]
    const s = summarizeUtilization(rows)
    expect(s.resourceCount).toBe(2)
    expect(s.rowCount).toBe(3)
  })

  it("tallies over-allocated and under-utilized resources", () => {
    const rows = [
      row({ resource_id: "r1", period: "2026-03", availableHours: 160, actualHours: 200 }), // over
      row({ resource_id: "r2", period: "2026-03", availableHours: 160, actualHours: 40 }), // under
      row({ resource_id: "r3", period: "2026-03", availableHours: 160, actualHours: 140 }), // optimal
    ]
    const s = summarizeUtilization(rows)
    expect(s.overAllocatedCount).toBe(1)
    expect(s.underUtilizedCount).toBe(1)
  })
})

describe("constants", () => {
  it("exposes sane defaults", () => {
    expect(DEFAULT_MONTHLY_CAPACITY_HOURS).toBe(160)
    expect(UTILIZATION_TARGET_PERCENT).toBe(75)
  })
})
