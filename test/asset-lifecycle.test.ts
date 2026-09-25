import { describe, it, expect } from "vitest"
import {
  WARRANTY_TYPES,
  MAINTENANCE_TYPES,
  MAINTENANCE_STATUSES,
  DEFAULT_WARRANTY_WARN_DAYS,
  DEFAULT_SERVICE_WARN_DAYS,
  AssetLifecycleError,
  isValidDate,
  advanceServiceDate,
  classifyExpiry,
  validateWarrantyInput,
  validateMaintenanceInput,
} from "@/lib/asset-lifecycle-model"

/**
 * Spec61 (#234-239) — Asset warranty & maintenance pure domain model.
 * DB-free and clock-injectable, so validation, failure and date-math paths are
 * pinned deterministically. Referenced by lib/asset-lifecycle-model.ts.
 */

describe("asset-lifecycle-model — isValidDate", () => {
  it("accepts canonical ISO dates and ISO datetimes", () => {
    expect(isValidDate("2026-02-28")).toBe(true)
    expect(isValidDate("2026-02-28T10:00:00Z")).toBe(true)
  })
  it("rejects empty, malformed and non-calendar values", () => {
    expect(isValidDate(null)).toBe(false)
    expect(isValidDate("")).toBe(false)
    expect(isValidDate("28-02-2026")).toBe(false)
    expect(isValidDate("2026/02/28")).toBe(false)
  })
})

describe("asset-lifecycle-model — advanceServiceDate", () => {
  it("advances whole months and clamps to the last valid day", () => {
    expect(advanceServiceDate("2026-01-31", 1)).toBe("2026-02-28")
    expect(advanceServiceDate("2024-01-31", 1)).toBe("2024-02-29") // leap year
    expect(advanceServiceDate("2026-03-15", 3)).toBe("2026-06-15")
    expect(advanceServiceDate("2026-11-30", 2)).toBe("2027-01-30") // year rollover
  })
  it("rejects invalid dates and non-positive intervals", () => {
    expect(() => advanceServiceDate("nope", 1)).toThrow(AssetLifecycleError)
    expect(() => advanceServiceDate("2026-01-31", 0)).toThrow(AssetLifecycleError)
    expect(() => advanceServiceDate("2026-01-31", -2)).toThrow(AssetLifecycleError)
  })
})

describe("asset-lifecycle-model — classifyExpiry (clock injected)", () => {
  const now = new Date("2026-06-01T00:00:00Z")
  it("flags an already-expired coverage date", () => {
    const r = classifyExpiry("2026-05-01", { now, timeZone: "UTC" })
    expect(r.daysUntil).toBeLessThan(0)
    expect(r.status).toBe("Expired")
  })
  it("flags coverage within the warn window as expiring", () => {
    const r = classifyExpiry("2026-06-20", { now, timeZone: "UTC", warnDays: 30 })
    expect(r.daysUntil).toBe(19)
    expect(r.status).toBe("Expiring Soon")
  })
  it("treats coverage well beyond the warn window as valid", () => {
    const r = classifyExpiry("2027-06-01", { now, timeZone: "UTC", warnDays: 30 })
    expect(r.status).toBe("Valid")
  })
})

describe("asset-lifecycle-model — validateWarrantyInput", () => {
  const good = {
    finance_fixed_asset_id: "42",
    provider: "Acme Corp",
    warranty_type: "Extended",
    start_date: "2026-01-01",
    expiry_date: "2027-01-01",
    cost: "1234.567",
  }

  it("normalizes a valid warranty and rounds cost to 2dp", () => {
    const n = validateWarrantyInput(good)
    expect(n.finance_fixed_asset_id).toBe("42")
    expect(n.warranty_type).toBe("Extended")
    expect(n.cost).toBe(1234.57)
    expect(n.reminder_days).toBe(DEFAULT_WARRANTY_WARN_DAYS)
    expect(WARRANTY_TYPES).toContain(n.warranty_type)
  })

  it("requires an asset on create but not on update", () => {
    expect(() => validateWarrantyInput({ ...good, finance_fixed_asset_id: "" })).toThrow(/select a fixed asset/i)
    expect(() => validateWarrantyInput({ ...good, finance_fixed_asset_id: "" }, true)).not.toThrow()
  })

  it("requires a provider and a valid expiry date", () => {
    expect(() => validateWarrantyInput({ ...good, provider: "  " })).toThrow(/provider is required/i)
    expect(() => validateWarrantyInput({ ...good, expiry_date: null })).toThrow(/valid warranty expiry/i)
  })

  it("rejects an unknown warranty type", () => {
    expect(() => validateWarrantyInput({ ...good, warranty_type: "Bogus" })).toThrow(/Invalid warranty type/i)
  })

  it("rejects an expiry earlier than the start date", () => {
    expect(() => validateWarrantyInput({ ...good, start_date: "2027-01-02" })).toThrow(/cannot be earlier/i)
  })

  it("rejects a negative or oversized cost", () => {
    expect(() => validateWarrantyInput({ ...good, cost: -1 })).toThrow(AssetLifecycleError)
    expect(() => validateWarrantyInput({ ...good, cost: 2_000_000_000 })).toThrow(AssetLifecycleError)
  })
})

describe("asset-lifecycle-model — validateMaintenanceInput", () => {
  const good = {
    finance_fixed_asset_id: "7",
    maintenance_type: "Preventive",
    status: "Scheduled",
    scheduled_date: "2026-06-01",
    description: "Quarterly service",
  }

  it("normalizes a valid maintenance record with defaults", () => {
    const n = validateMaintenanceInput(good)
    expect(n.maintenance_type).toBe("Preventive")
    expect(n.status).toBe("Scheduled")
    expect(n.reminder_days).toBe(DEFAULT_SERVICE_WARN_DAYS)
    expect(MAINTENANCE_TYPES).toContain(n.maintenance_type)
    expect(MAINTENANCE_STATUSES).toContain(n.status)
  })

  it("requires a description", () => {
    expect(() => validateMaintenanceInput({ ...good, description: "" })).toThrow(/description is required/i)
  })

  it("requires a performed date to complete a record", () => {
    expect(() => validateMaintenanceInput({ ...good, status: "Completed" })).toThrow(/performed date is required/i)
    expect(() =>
      validateMaintenanceInput({ ...good, status: "Completed", performed_date: "2026-06-02" }),
    ).not.toThrow()
  })

  it("rejects unknown type/status and invalid dates", () => {
    expect(() => validateMaintenanceInput({ ...good, maintenance_type: "X" })).toThrow(/Invalid maintenance type/i)
    expect(() => validateMaintenanceInput({ ...good, status: "X" })).toThrow(/Invalid status/i)
    expect(() => validateMaintenanceInput({ ...good, scheduled_date: "bad" })).toThrow(/Scheduled date is invalid/i)
  })
})
