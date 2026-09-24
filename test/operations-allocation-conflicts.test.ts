import { describe, expect, it } from "vitest"
import {
  detectAllocationConflicts,
  rangesOverlap,
  summarizeConflicts,
  type ConflictAllocationRow,
  type LeaveRow,
} from "@/lib/operations-resource-management"

/**
 * SPEC 147 — Phase 4. Pure, DB-free validation of the allocation conflict
 * engine that guards resource assignment: over-allocation, overlapping windows,
 * single-row capacity breaches, and clashes with approved leave. The same
 * detector powers both the live conflict route and the pre-save candidate
 * preview, so its output must be exact.
 */

function alloc(over: Partial<ConflictAllocationRow>): ConflictAllocationRow {
  return {
    resource_id: over.resource_id ?? "R1",
    resource_name: over.resource_name ?? "Asha",
    project_id: over.project_id ?? "P1",
    client_name: over.client_name ?? "Acme",
    role: over.role ?? "Engineer",
    allocation_percent: over.allocation_percent ?? 50,
    from_date: over.from_date ?? "2026-01-01",
    to_date: over.to_date ?? "2026-01-31",
    working_capacity: over.working_capacity ?? 160,
    allocated_capacity: over.allocated_capacity ?? 80,
    status: over.status ?? "Active",
  }
}

describe("rangesOverlap", () => {
  it("treats touching and open-ended ranges as overlapping", () => {
    expect(rangesOverlap("2026-01-01", "2026-01-10", "2026-01-10", "2026-01-20")).toBe(true)
    expect(rangesOverlap("2026-01-01", null, "2030-01-01", "2030-02-01")).toBe(true)
  })

  it("returns false for fully separate ranges", () => {
    expect(rangesOverlap("2026-01-01", "2026-01-10", "2026-02-01", "2026-02-10")).toBe(false)
  })
})

describe("detectAllocationConflicts", () => {
  it("finds no conflict for non-overlapping allocations within capacity", () => {
    const conflicts = detectAllocationConflicts(
      [
        alloc({ from_date: "2026-01-01", to_date: "2026-01-31", allocation_percent: 50 }),
        alloc({ from_date: "2026-02-01", to_date: "2026-02-28", allocation_percent: 50, project_id: "P2" }),
      ],
      [],
    )
    expect(conflicts).toHaveLength(0)
  })

  it("flags over-allocation when overlapping percentages exceed 100", () => {
    const conflicts = detectAllocationConflicts(
      [
        alloc({ allocation_percent: 70, project_id: "P1" }),
        alloc({ allocation_percent: 60, project_id: "P2" }),
      ],
      [],
    )
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].type).toBe("over_allocation")
    expect(conflicts[0].severity).toBe("critical")
  })

  it("flags a plain overlap (warning) when the combined percentage stays within 100", () => {
    const conflicts = detectAllocationConflicts(
      [
        alloc({ allocation_percent: 40, project_id: "P1" }),
        alloc({ allocation_percent: 50, project_id: "P2" }),
      ],
      [],
    )
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].type).toBe("overlap")
    expect(conflicts[0].severity).toBe("warning")
  })

  it("flags a single row allocated beyond its working capacity", () => {
    const conflicts = detectAllocationConflicts(
      [alloc({ allocated_capacity: 200, working_capacity: 160 })],
      [],
    )
    expect(conflicts.some((c) => c.type === "capacity_exceeded")).toBe(true)
  })

  it("flags a clash with approved leave", () => {
    const leaves: LeaveRow[] = [
      { employee_name: "Asha", employee_id: 1, from_date: "2026-01-15", to_date: "2026-01-20", status: "HR Approved" },
    ]
    const conflicts = detectAllocationConflicts([alloc({ resource_name: "Asha" })], leaves)
    expect(conflicts.some((c) => c.type === "on_leave")).toBe(true)
  })

  it("previews only the candidate's conflicts without mutating saved rows", () => {
    const saved = [alloc({ allocation_percent: 80, project_id: "P1" })]
    const candidate = alloc({ allocation_percent: 40, project_id: "P2" })
    const conflicts = detectAllocationConflicts(saved, [], candidate)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].type).toBe("over_allocation")
    // The candidate is included by identity in the related set.
    expect(conflicts[0].related).toContain(candidate)
  })
})

describe("summarizeConflicts", () => {
  it("tallies conflicts by type", () => {
    const conflicts = detectAllocationConflicts(
      [
        alloc({ allocation_percent: 70, project_id: "P1" }),
        alloc({ allocation_percent: 60, project_id: "P2" }),
        alloc({ resource_id: "R2", resource_name: "Ben", allocated_capacity: 200, working_capacity: 160 }),
      ],
      [],
    )
    const summary = summarizeConflicts(conflicts)
    expect(summary.total).toBe(conflicts.length)
    expect(summary.over_allocation).toBe(1)
    expect(summary.capacity_exceeded).toBe(1)
  })
})
