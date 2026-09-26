import { describe, expect, it } from "vitest"
import {
  computeAvailability,
  detectConflicts,
  parseResolutionInput,
  planResolution,
  ResolutionError,
  type AllocationRow,
} from "@/lib/resource-conflicts-model"
import { computeProfitability } from "@/lib/project-profitability-model"

const alloc = (id: number, pct: number, from: string, to: string, extra: Partial<AllocationRow> = {}): AllocationRow => ({
  id,
  resource_id: "R1",
  resource_name: "Asha",
  project_id: `P${id}`,
  client_name: null,
  role: "Dev",
  allocation_percent: pct,
  from_date: from,
  to_date: to,
  working_capacity: null,
  allocated_capacity: null,
  status: "Active",
  ...extra,
})

describe("resource conflicts model", () => {
  const rows = [alloc(1, 60, "2026-10-01", "2026-10-31"), alloc(2, 60, "2026-10-15", "2026-11-15")]

  it("detects over-allocation for overlapping ranges", () => {
    const conflicts = detectConflicts(rows, [])
    expect(conflicts.some((c) => c.type === "over_allocation")).toBe(true)
  })

  it("does not flag non-overlapping allocations", () => {
    const conflicts = detectConflicts([alloc(1, 80, "2026-10-01", "2026-10-10"), alloc(2, 80, "2026-10-11", "2026-10-20")], [])
    expect(conflicts.filter((c) => c.type === "over_allocation")).toHaveLength(0)
  })

  it("flags allocations during approved leave only", () => {
    const leave = { employee_name: "Asha", employee_id: null, from_date: "2026-10-05", to_date: "2026-10-06", status: "HR Approved" }
    expect(detectConflicts([rows[0]], [leave]).some((c) => c.type === "on_leave")).toBe(true)
    expect(detectConflicts([rows[0]], [{ ...leave, status: "Pending" }]).some((c) => c.type === "on_leave")).toBe(false)
  })

  it("plans a resolution that removes the conflict", () => {
    const conflict = detectConflicts(rows, []).find((c) => c.type === "over_allocation")!
    const input = parseResolutionInput({ conflict_key: conflict.key, action: "reduce_percent", allocation_id: "2", allocation_percent: 40 })
    const plan = planResolution(input, rows, [])
    expect(plan.patch).toEqual({ allocation_percent: 40 })
  })

  it("rejects a resolution that does not resolve the conflict", () => {
    const conflict = detectConflicts(rows, []).find((c) => c.type === "over_allocation")!
    const input = parseResolutionInput({ conflict_key: conflict.key, action: "reduce_percent", allocation_id: "2", allocation_percent: 50 })
    expect(() => planResolution(input, rows, [])).toThrow(ResolutionError)
  })

  it("rejects stale conflict keys with 409", () => {
    const input = parseResolutionInput({ conflict_key: "missing", action: "accept", reason: "ok" })
    try {
      planResolution(input, rows, [])
      throw new Error("expected throw")
    } catch (e) {
      expect((e as ResolutionError).status).toBe(409)
    }
  })

  it("validates resolution input", () => {
    expect(() => parseResolutionInput({ conflict_key: "k", action: "accept" })).toThrow(/reason/)
    expect(() => parseResolutionInput({ conflict_key: "k", action: "delete" })).toThrow(ResolutionError)
    expect(() =>
      parseResolutionInput({ conflict_key: "k", action: "shift_dates", allocation_id: 1, from_date: "2026-10-10", to_date: "2026-10-01" }),
    ).toThrow(/after/)
  })

  it("computes peak availability within a window", () => {
    const [a] = computeAvailability(rows, [], "2026-10-01", "2026-11-30")
    expect(a.peak_allocation_percent).toBe(120)
    expect(a.status).toBe("Over Allocated")
    const [b] = computeAvailability(rows, [], "2026-11-01", "2026-11-30")
    expect(b.peak_allocation_percent).toBe(60)
  })
})

describe("project profitability model", () => {
  it("computes margin, status and budget burn", () => {
    const rows = computeProfitability([
      { key: "a", label: "A", revenue: 1000, cost: 700, budget: 1000, progress: 50 },
      { key: "b", label: "B", revenue: 1000, cost: 950, budget: 0, progress: null },
      { key: "c", label: "C", revenue: 500, cost: 800, budget: 0, progress: null },
      { key: "d", label: "D", revenue: 0, cost: 100, budget: 0, progress: null },
      { key: "e", label: "E", revenue: 0, cost: 0, budget: 0, progress: null },
    ])
    const by = Object.fromEntries(rows.map((r) => [r.project_name, r]))
    expect(by.A).toMatchObject({ gross_profit: 300, margin_percent: 30, status: "Profitable", budget_used_percent: 70 })
    expect(by.B.status).toBe("Low Margin")
    expect(by.C.status).toBe("Loss")
    expect(by.D).toMatchObject({ status: "No Revenue", margin_percent: -100 })
    expect(by.E).toBeUndefined()
    expect(rows[0].project_name).toBe("C")
  })
})
