import { describe, it, expect } from "vitest"
import {
  toISODate,
  todayInTimeZone,
  daysBetween,
  daysUntilExpiry,
  classifyStatus,
  escalationTier,
  renewalStatus,
  reminderMilestone,
  evaluateExpiry,
} from "@/lib/expiry/date"
import { categorizeDocumentType } from "@/lib/expiry/model"

describe("expiry/date — toISODate normalisation", () => {
  it("passes through canonical date strings", () => {
    expect(toISODate("2026-09-30")).toBe("2026-09-30")
  })
  it("truncates ISO datetimes to the calendar date", () => {
    expect(toISODate("2026-09-30T18:30:00.000Z")).toBe("2026-09-30")
  })
  it("reads Date values in UTC so no day slips in negative offsets", () => {
    // Midnight UTC — a naive local read in the Americas would report Sep 29.
    expect(toISODate(new Date("2026-09-30T00:00:00.000Z"))).toBe("2026-09-30")
  })
  it("returns null for empty/invalid input", () => {
    expect(toISODate(null)).toBeNull()
    expect(toISODate("")).toBeNull()
    expect(toISODate("not-a-date")).toBeNull()
    expect(toISODate(new Date("invalid"))).toBeNull()
  })
})

describe("expiry/date — timezone-aware today", () => {
  it("rolls the calendar day forward east of UTC", () => {
    // 22:00 UTC is already the next day in Asia/Kolkata (+05:30) and Tokyo.
    const instant = new Date("2026-09-30T22:00:00.000Z")
    expect(todayInTimeZone(instant, "UTC")).toBe("2026-09-30")
    expect(todayInTimeZone(instant, "Asia/Kolkata")).toBe("2026-10-01")
    expect(todayInTimeZone(instant, "Asia/Tokyo")).toBe("2026-10-01")
  })
  it("stays on the previous day west of UTC", () => {
    const instant = new Date("2026-10-01T02:00:00.000Z")
    expect(todayInTimeZone(instant, "America/Los_Angeles")).toBe("2026-09-30")
  })
  it("falls back to UTC for an invalid timezone instead of throwing", () => {
    const instant = new Date("2026-09-30T12:00:00.000Z")
    expect(todayInTimeZone(instant, "Not/AZone")).toBe("2026-09-30")
  })
})

describe("expiry/date — daysBetween is DST-immune", () => {
  it("counts whole days across a US spring-forward boundary", () => {
    // DST begins 2026-03-08 in the US; a naive local-ms diff could yield 30.96.
    expect(daysBetween("2026-03-01", "2026-03-31")).toBe(30)
  })
  it("is negative when the target is in the past", () => {
    expect(daysBetween("2026-09-30", "2026-09-28")).toBe(-2)
  })
  it("is zero for the same day", () => {
    expect(daysBetween("2026-09-30", "2026-09-30")).toBe(0)
  })
})

describe("expiry/date — daysUntilExpiry", () => {
  const now = new Date("2026-09-30T12:00:00.000Z")
  it("computes days until a future expiry in the business timezone", () => {
    expect(daysUntilExpiry("2026-10-10", { now, timeZone: "Asia/Kolkata" })).toBe(10)
  })
  it("returns 0 on the expiry day itself", () => {
    expect(daysUntilExpiry("2026-09-30", { now, timeZone: "Asia/Kolkata" })).toBe(0)
  })
  it("returns null for unparseable input", () => {
    expect(daysUntilExpiry(null, { now })).toBeNull()
  })
})

describe("expiry/date — status classification", () => {
  it("classifies None / Valid / Expiring Soon / Expired", () => {
    expect(classifyStatus(null)).toBe("None")
    expect(classifyStatus(45, 30)).toBe("Valid")
    expect(classifyStatus(30, 30)).toBe("Expiring Soon")
    expect(classifyStatus(0, 30)).toBe("Expiring Soon")
    expect(classifyStatus(-1, 30)).toBe("Expired")
  })
  it("respects a custom warn window", () => {
    expect(classifyStatus(20, 7)).toBe("Valid")
    expect(classifyStatus(7, 7)).toBe("Expiring Soon")
  })
})

describe("expiry/date — escalation tiers", () => {
  it("escalates by proximity", () => {
    expect(escalationTier(45, 30)).toBe("none")
    expect(escalationTier(20, 30)).toBe("notice")
    expect(escalationTier(7, 30)).toBe("warning")
    expect(escalationTier(3, 30)).toBe("urgent")
    expect(escalationTier(0, 30)).toBe("urgent")
    expect(escalationTier(-5, 30)).toBe("overdue")
  })
})

describe("expiry/date — renewal status", () => {
  it("maps status to a renewal label", () => {
    expect(renewalStatus("Valid")).toBe("Current")
    expect(renewalStatus("Expiring Soon")).toBe("Renewal Due")
    expect(renewalStatus("Expired")).toBe("Renewal Overdue")
    expect(renewalStatus("None")).toBe("Not Applicable")
  })
})

describe("expiry/date — reminder milestones", () => {
  it("returns null outside the warn window", () => {
    expect(reminderMilestone(45, 30)).toBeNull()
  })
  it("hits each threshold once as the date approaches", () => {
    expect(reminderMilestone(30, 30)).toBe("d30")
    expect(reminderMilestone(20, 30)).toBe("d30")
    expect(reminderMilestone(15, 30)).toBe("d15")
    expect(reminderMilestone(7, 30)).toBe("d7")
    expect(reminderMilestone(3, 30)).toBe("d3")
    expect(reminderMilestone(1, 30)).toBe("d1")
    expect(reminderMilestone(0, 30)).toBe("d0")
  })
  it("re-escalates overdue items on a weekly cadence", () => {
    expect(reminderMilestone(-1, 30)).toBe("overdue-w0")
    expect(reminderMilestone(-7, 30)).toBe("overdue-w0")
    expect(reminderMilestone(-8, 30)).toBe("overdue-w1")
    expect(reminderMilestone(-15, 30)).toBe("overdue-w2")
  })
  it("caps milestones to a short warn window", () => {
    // With a 7-day window we never emit d15/d30.
    expect(reminderMilestone(10, 7)).toBeNull()
    expect(reminderMilestone(7, 7)).toBe("d7")
  })
})

describe("expiry/date — evaluateExpiry bundle", () => {
  const now = new Date("2026-09-30T12:00:00.000Z")
  it("produces a coherent classification bundle", () => {
    const r = evaluateExpiry("2026-10-05", { now, timeZone: "Asia/Kolkata", warnDays: 30 })
    expect(r).toMatchObject({
      expiryDate: "2026-10-05",
      daysUntil: 5,
      status: "Expiring Soon",
      escalation: "warning",
      renewalStatus: "Renewal Due",
      milestone: "d7",
    })
  })
  it("handles an already-expired document", () => {
    const r = evaluateExpiry("2026-09-20", { now, timeZone: "Asia/Kolkata", warnDays: 30 })
    expect(r.status).toBe("Expired")
    expect(r.escalation).toBe("overdue")
    expect(r.renewalStatus).toBe("Renewal Overdue")
    expect(r.milestone).toBe("overdue-w1")
  })
})

describe("expiry/model — document categorisation", () => {
  it("maps common document types to categories", () => {
    expect(categorizeDocumentType("Public Liability Insurance")).toBe("Insurance")
    expect(categorizeDocumentType("Driving Licence")).toBe("License")
    expect(categorizeDocumentType("ISO 27001 Certification")).toBe("Certification")
    expect(categorizeDocumentType("Signed NDA")).toBe("Compliance")
    expect(categorizeDocumentType("Passport")).toBe("Identity")
    expect(categorizeDocumentType("Offer Letter")).toBe("Employee Document")
    expect(categorizeDocumentType(null)).toBe("Employee Document")
  })
})
