import { describe, expect, it } from "vitest"
import {
  OVERTIME_MULTIPLIER,
  STANDARD_DAILY_HOURS,
  approvalBreakdown,
  computeEntryHours,
  computePayroll,
  hoursFromClock,
  normalizeEntry,
  rollupBy,
  splitRegularOvertime,
  summarizeTimeEntries,
  type RateResolver,
  type TimeEntry,
} from "@/lib/operations-time-tracking"

/**
 * SPEC 148 — Phase 4. Pure, DB-free validation that the normalized Time Tracking
 * report reconciles to the underlying timesheet numbers: hour splits, project /
 * client roll-ups, overtime, approval workflow buckets and payroll/billing.
 */

function entry(over: Partial<TimeEntry> & { work_date: string }): TimeEntry {
  return normalizeEntry({
    resource_id: over.resource_id ?? "r1",
    resource_name: over.resource_name ?? "Alice",
    project_id: over.project_id ?? "p1",
    project_name: over.project_name ?? "Apollo",
    client_name: over.client_name ?? "Acme",
    work_date: over.work_date,
    hours_worked: over.totalHours,
    billable_hours: over.billableHours,
    non_billable_hours: over.nonBillableHours,
    approval_status: over.approvalStatus ?? "Approved",
  })
}

describe("hoursFromClock", () => {
  it("computes a normal same-day span", () => {
    expect(hoursFromClock("09:00", "17:30")).toBe(8.5)
  })
  it("handles a shift crossing midnight", () => {
    expect(hoursFromClock("22:00", "06:00")).toBe(8)
  })
  it("returns 0 for malformed input", () => {
    expect(hoursFromClock("nope", "17:00")).toBe(0)
    expect(hoursFromClock("25:00", "26:00")).toBe(0)
  })
})

describe("computeEntryHours", () => {
  it("splits billable and non-billable from explicit billable hours", () => {
    const h = computeEntryHours({ hours_worked: 8, billable_hours: 6 })
    expect(h.totalHours).toBe(8)
    expect(h.billableHours).toBe(6)
    expect(h.nonBillableHours).toBe(2)
  })

  it("derives billable from non-billable when billable is absent", () => {
    const h = computeEntryHours({ hours_worked: 8, non_billable_hours: 3 })
    expect(h.billableHours).toBe(5)
    expect(h.nonBillableHours).toBe(3)
  })

  it("treats hours as all-billable when neither split column is present", () => {
    const h = computeEntryHours({ hours_worked: 7 })
    expect(h.billableHours).toBe(7)
    expect(h.nonBillableHours).toBe(0)
  })

  it("falls back to clock times when hours_worked is missing", () => {
    const h = computeEntryHours({ start_time: "09:00", end_time: "13:00" })
    expect(h.totalHours).toBe(4)
  })

  it("clamps billable to total so non-billable never goes negative", () => {
    const h = computeEntryHours({ hours_worked: 5, billable_hours: 9 })
    expect(h.billableHours).toBe(5)
    expect(h.nonBillableHours).toBe(0)
  })

  it("reconciles billable + non-billable back to total", () => {
    const h = computeEntryHours({ hours_worked: 7.25, billable_hours: 4.5 })
    expect(h.billableHours + h.nonBillableHours).toBe(h.totalHours)
  })
})

describe("splitRegularOvertime", () => {
  it("keeps a standard day fully regular", () => {
    const s = splitRegularOvertime(8)
    expect(s.regularHours).toBe(8)
    expect(s.overtimeHours).toBe(0)
  })
  it("counts hours beyond the standard day as overtime", () => {
    const s = splitRegularOvertime(11)
    expect(s.regularHours).toBe(STANDARD_DAILY_HOURS)
    expect(s.overtimeHours).toBe(3)
  })
  it("never returns negative overtime for a short day", () => {
    const s = splitRegularOvertime(5)
    expect(s.regularHours).toBe(5)
    expect(s.overtimeHours).toBe(0)
  })
})

describe("normalizeEntry", () => {
  it("buckets the work date into a YYYY-MM period", () => {
    const e = normalizeEntry({ work_date: "2026-03-14", hours_worked: 8 })
    expect(e.period).toBe("2026-03")
    expect(e.work_date).toBe("2026-03-14")
  })
  it("labels missing client/resource defensively", () => {
    const e = normalizeEntry({ work_date: "2026-03-14", hours_worked: 8 })
    expect(e.client_name).toBe("Unassigned")
    expect(e.resource_name).toBe("Unknown resource")
  })
})

describe("summarizeTimeEntries", () => {
  it("returns an all-zero summary for no entries", () => {
    const s = summarizeTimeEntries([])
    expect(s.totalHours).toBe(0)
    expect(s.overtimeHours).toBe(0)
    expect(s.billablePercent).toBe(0)
  })

  it("computes overtime per day, not per month", () => {
    // Two 10h days in the same month = 20h total, 16h regular, 4h overtime.
    const entries = [
      entry({ work_date: "2026-03-02", totalHours: 10 }),
      entry({ work_date: "2026-03-03", totalHours: 10 }),
    ]
    const s = summarizeTimeEntries(entries)
    expect(s.totalHours).toBe(20)
    expect(s.regularHours).toBe(16)
    expect(s.overtimeHours).toBe(4)
  })

  it("sums a resource's multiple entries on the same day before splitting overtime", () => {
    // 5h on project A + 5h on project B, same day = 10h day → 2h overtime.
    const entries = [
      entry({ work_date: "2026-03-02", project_id: "pA", totalHours: 5 }),
      entry({ work_date: "2026-03-02", project_id: "pB", totalHours: 5 }),
    ]
    const s = summarizeTimeEntries(entries)
    expect(s.overtimeHours).toBe(2)
    expect(s.regularHours).toBe(8)
  })

  it("reconciles billable + non-billable to total and counts dimensions", () => {
    const entries = [
      entry({ work_date: "2026-03-02", resource_id: "r1", project_id: "p1", client_name: "Acme", totalHours: 8, billableHours: 6 }),
      entry({ work_date: "2026-03-02", resource_id: "r2", project_id: "p2", client_name: "Globex", totalHours: 8, billableHours: 4 }),
    ]
    const s = summarizeTimeEntries(entries)
    expect(s.totalHours).toBe(16)
    expect(s.billableHours).toBe(10)
    expect(s.nonBillableHours).toBe(6)
    expect(s.billableHours + s.nonBillableHours).toBe(s.totalHours)
    expect(s.billablePercent).toBe(62.5)
    expect(s.resourceCount).toBe(2)
    expect(s.projectCount).toBe(2)
    expect(s.clientCount).toBe(2)
  })
})

describe("rollupBy", () => {
  const entries = [
    entry({ work_date: "2026-03-02", resource_id: "r1", resource_name: "Alice", project_id: "p1", project_name: "Apollo", client_name: "Acme", totalHours: 10, billableHours: 8 }),
    entry({ work_date: "2026-03-03", resource_id: "r1", resource_name: "Alice", project_id: "p2", project_name: "Zephyr", client_name: "Globex", totalHours: 6, billableHours: 6 }),
    entry({ work_date: "2026-03-02", resource_id: "r2", resource_name: "Bob", project_id: "p1", project_name: "Apollo", client_name: "Acme", totalHours: 8, billableHours: 2 }),
  ]

  it("rolls up by client and reconciles hours to the source entries", () => {
    const rows = rollupBy(entries, "client")
    const acme = rows.find((r) => r.label === "Acme")!
    const globex = rows.find((r) => r.label === "Globex")!
    expect(acme.totalHours).toBe(18) // 10 (Alice) + 8 (Bob)
    expect(globex.totalHours).toBe(6)
    expect(acme.billableHours).toBe(10) // 8 + 2
  })

  it("rolls up by project", () => {
    const rows = rollupBy(entries, "project")
    const apollo = rows.find((r) => r.label === "Apollo")!
    expect(apollo.totalHours).toBe(18)
    expect(apollo.entryCount).toBe(2)
  })

  it("prorates overtime across the groups the hours were logged to", () => {
    // Alice: 10h day (2h OT) on Apollo, 6h day (0 OT) on Zephyr → 2h OT total,
    // fully attributed to the Apollo/Acme day.
    const byResource = rollupBy(entries, "resource")
    const alice = byResource.find((r) => r.label === "Alice")!
    expect(alice.overtimeHours).toBe(2)
    const totalOt = byResource.reduce((sum, r) => sum + r.overtimeHours, 0)
    // Alice 2h + Bob 0h; matches the portfolio overtime.
    expect(totalOt).toBe(summarizeTimeEntries(entries).overtimeHours)
  })
})

describe("computePayroll", () => {
  const rateOf: RateResolver = () => 100 // flat 100/hr

  it("pays overtime at the configured premium", () => {
    // One 10h day: 8h regular @100 = 800, 2h OT @150 = 300, total 1100.
    const rows = computePayroll([entry({ work_date: "2026-03-02", totalHours: 10 })], rateOf)
    expect(rows).toHaveLength(1)
    const p = rows[0]
    expect(p.regularHours).toBe(8)
    expect(p.overtimeHours).toBe(2)
    expect(p.regularPay).toBe(800)
    expect(p.overtimePay).toBe(300)
    expect(p.totalPay).toBe(1100)
    expect(OVERTIME_MULTIPLIER).toBe(1.5)
  })

  it("produces zero pay when no rate is known", () => {
    const rows = computePayroll([entry({ work_date: "2026-03-02", totalHours: 8 })], () => 0)
    expect(rows[0].totalPay).toBe(0)
  })

  it("splits payroll rows per resource per period", () => {
    const rows = computePayroll(
      [
        entry({ work_date: "2026-02-10", resource_id: "r1", totalHours: 8 }),
        entry({ work_date: "2026-03-10", resource_id: "r1", totalHours: 8 }),
        entry({ work_date: "2026-03-10", resource_id: "r2", resource_name: "Bob", totalHours: 8 }),
      ],
      rateOf,
    )
    expect(rows).toHaveLength(3)
  })
})

describe("approvalBreakdown", () => {
  it("buckets hours by approval lifecycle state", () => {
    const entries = [
      entry({ work_date: "2026-03-02", totalHours: 8, approvalStatus: "Approved" }),
      entry({ work_date: "2026-03-03", totalHours: 4, approvalStatus: "Submitted" }),
      entry({ work_date: "2026-03-04", totalHours: 2, approvalStatus: "Draft" }),
      entry({ work_date: "2026-03-05", totalHours: 1, approvalStatus: "Rejected" }),
    ]
    const b = approvalBreakdown(entries)
    expect(b.approvedHours).toBe(8)
    expect(b.submittedHours).toBe(4)
    expect(b.draftHours).toBe(2)
    expect(b.rejectedHours).toBe(1)
    expect(b.approvedCount).toBe(1)
    expect(b.submittedCount).toBe(1)
  })

  it("treats an unknown/empty status as Draft", () => {
    const b = approvalBreakdown([entry({ work_date: "2026-03-02", totalHours: 8, approvalStatus: "" })])
    expect(b.draftCount).toBe(1)
    expect(b.draftHours).toBe(8)
  })
})
