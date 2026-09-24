import { describe, it, expect } from "vitest"
import {
  generateMonthlyPeriods,
  canClosePeriod,
  canLockPeriod,
  canRequestReopen,
  isPostingBlockedStatus,
  type PeriodStatus,
} from "@/lib/finance/fiscal-year"

describe("generateMonthlyPeriods", () => {
  it("splits a standard April→March fiscal year into 12 monthly periods", () => {
    const periods = generateMonthlyPeriods("2026-04-01", "2027-03-31")
    expect(periods).toHaveLength(12)
    expect(periods[0]).toMatchObject({
      seq: 1,
      name: "Apr 2026",
      periodKey: "2026-04",
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    })
    expect(periods[11]).toMatchObject({
      seq: 12,
      name: "Mar 2027",
      periodKey: "2027-03",
      startDate: "2027-03-01",
      endDate: "2027-03-31",
    })
  })

  it("handles a calendar (Jan→Dec) fiscal year", () => {
    const periods = generateMonthlyPeriods("2026-01-01", "2026-12-31")
    expect(periods).toHaveLength(12)
    expect(periods[0].periodKey).toBe("2026-01")
    expect(periods[11].periodKey).toBe("2026-12")
    // February end-of-month is correct (non-leap year).
    expect(periods[1].endDate).toBe("2026-02-28")
  })

  it("clamps the first and last period to the exact start/end dates", () => {
    const periods = generateMonthlyPeriods("2026-04-15", "2026-06-10")
    expect(periods).toHaveLength(3)
    expect(periods[0]).toMatchObject({ startDate: "2026-04-15", endDate: "2026-04-30" })
    expect(periods[1]).toMatchObject({ startDate: "2026-05-01", endDate: "2026-05-31" })
    expect(periods[2]).toMatchObject({ startDate: "2026-06-01", endDate: "2026-06-10" })
  })

  it("produces a single period when start and end share a month", () => {
    const periods = generateMonthlyPeriods("2026-07-05", "2026-07-20")
    expect(periods).toHaveLength(1)
    expect(periods[0]).toMatchObject({ startDate: "2026-07-05", endDate: "2026-07-20" })
  })

  it("returns [] for an inverted or invalid range", () => {
    expect(generateMonthlyPeriods("2027-01-01", "2026-01-01")).toEqual([])
    expect(generateMonthlyPeriods("", "2026-01-01")).toEqual([])
    expect(generateMonthlyPeriods("not-a-date", "also-bad")).toEqual([])
  })
})

describe("period state transitions", () => {
  it("only allows closing an Open period", () => {
    expect(canClosePeriod("Open")).toBe(true)
    expect(canClosePeriod("Closed")).toBe(false)
    expect(canClosePeriod("Locked")).toBe(false)
  })

  it("allows locking an Open or Closed period, but not an already-Locked one", () => {
    expect(canLockPeriod("Open")).toBe(true)
    expect(canLockPeriod("Closed")).toBe(true)
    expect(canLockPeriod("Locked")).toBe(false)
  })

  it("only allows reopening a sealed (Closed/Locked) period", () => {
    expect(canRequestReopen("Open")).toBe(false)
    expect(canRequestReopen("Closed")).toBe(true)
    expect(canRequestReopen("Locked")).toBe(true)
  })

  it("blocks postings whenever a period is not Open", () => {
    const cases: Array<[PeriodStatus, boolean]> = [
      ["Open", false],
      ["Closed", true],
      ["Locked", true],
    ]
    for (const [status, blocked] of cases) {
      expect(isPostingBlockedStatus(status)).toBe(blocked)
    }
  })

  it("models the full close → request-reopen → approve lifecycle", () => {
    // Close an open period.
    let status: PeriodStatus = "Open"
    expect(canClosePeriod(status)).toBe(true)
    status = "Closed"
    expect(isPostingBlockedStatus(status)).toBe(true)

    // A reopen request is valid on a closed period; approval returns it to Open.
    expect(canRequestReopen(status)).toBe(true)
    status = "Open" // approveReopen sets the period back to Open
    expect(isPostingBlockedStatus(status)).toBe(false)
    // Once open again there is nothing left to reopen.
    expect(canRequestReopen(status)).toBe(false)
  })
})
