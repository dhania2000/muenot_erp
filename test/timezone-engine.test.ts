import { describe, expect, it } from "vitest"
import {
  DEFAULT_TIME_ZONE,
  UTC,
  isValidTimeZone,
  normalizeTimeZone,
  assertTimeZone,
  getOffsetMinutes,
  formatOffset,
  zonedTimeToUtc,
  wallStringToUtc,
  utcToZonedParts,
  utcToWallString,
  zonedDateOnly,
  toZonedIso,
  resolveTimeZone,
  RESOLUTION_ORDER,
} from "@/lib/timezone"

/**
 * SPEC 158 — TIMEZONE ENGINE.
 * PHASE 4: DST transitions and multi-country scenarios exercised against the
 * pure engine that every layer (tenant/user/entity/job/report) resolves through.
 */

describe("validation", () => {
  it("accepts real IANA zones", () => {
    for (const tz of ["Asia/Kolkata", "UTC", "America/New_York", "Europe/London", "Australia/Sydney"]) {
      expect(isValidTimeZone(tz)).toBe(true)
    }
  })

  it("rejects junk, fixed offsets and non-strings", () => {
    for (const bad of ["", "  ", "Not/AZone", "+05:30", "GMT+5", 5, null, undefined, {}]) {
      expect(isValidTimeZone(bad as unknown)).toBe(false)
    }
  })

  it("normalizeTimeZone falls back without throwing", () => {
    expect(normalizeTimeZone("Not/AZone")).toBe(DEFAULT_TIME_ZONE)
    expect(normalizeTimeZone("Not/AZone", "UTC")).toBe(UTC)
    expect(normalizeTimeZone("Asia/Dubai")).toBe("Asia/Dubai")
    // fallback is itself invalid -> UTC as the last resort
    expect(normalizeTimeZone(null, "Also/Bad")).toBe(UTC)
  })

  it("assertTimeZone throws on invalid input", () => {
    expect(() => assertTimeZone("Not/AZone")).toThrow(/invalid iana timezone/i)
    expect(assertTimeZone("  Europe/London  ")).toBe("Europe/London")
  })
})

describe("offsets (multi-country)", () => {
  // A fixed winter instant so no country is in DST.
  const winter = new Date("2024-01-15T00:00:00Z")

  it("computes standard offsets around the world", () => {
    expect(getOffsetMinutes(winter, "UTC")).toBe(0)
    expect(getOffsetMinutes(winter, "Asia/Kolkata")).toBe(330) // +05:30
    expect(getOffsetMinutes(winter, "Asia/Kathmandu")).toBe(345) // +05:45
    expect(getOffsetMinutes(winter, "America/New_York")).toBe(-300) // -05:00 EST
    expect(getOffsetMinutes(winter, "Pacific/Chatham")).toBe(825) // +13:45 (DST)
  })

  it("formats offsets as +HH:MM", () => {
    expect(formatOffset(330)).toBe("+05:30")
    expect(formatOffset(-300)).toBe("-05:00")
    expect(formatOffset(0)).toBe("+00:00")
    expect(formatOffset(345)).toBe("+05:45")
  })
})

describe("DST — US spring forward (2024-03-10 02:00 -> 03:00 America/New_York)", () => {
  it("offset shifts EST -> EDT across the boundary", () => {
    expect(getOffsetMinutes(new Date("2024-03-10T06:00:00Z"), "America/New_York")).toBe(-300) // 01:00 EST
    expect(getOffsetMinutes(new Date("2024-03-10T07:00:00Z"), "America/New_York")).toBe(-240) // 03:00 EDT
  })

  it("a non-existent wall time (02:30) resolves deterministically forward", () => {
    // 02:30 does not exist; engine refines to a real instant (03:30 EDT = 07:30Z).
    const instant = zonedTimeToUtc(
      { year: 2024, month: 3, day: 10, hour: 2, minute: 30, second: 0 },
      "America/New_York",
    )
    expect(instant.toISOString()).toBe("2024-03-10T07:30:00.000Z")
  })

  it("round-trips a normal wall time either side of the gap", () => {
    const before = { year: 2024, month: 3, day: 10, hour: 1, minute: 0, second: 0 }
    const after = { year: 2024, month: 3, day: 10, hour: 4, minute: 0, second: 0 }
    for (const parts of [before, after]) {
      const back = utcToZonedParts(zonedTimeToUtc(parts, "America/New_York"), "America/New_York")
      expect(back).toMatchObject(parts)
    }
  })
})

describe("DST — US fall back (2024-11-03 02:00 -> 01:00 America/New_York)", () => {
  it("offset shifts EDT -> EST across the boundary", () => {
    expect(getOffsetMinutes(new Date("2024-11-03T05:00:00Z"), "America/New_York")).toBe(-240) // 01:00 EDT
    expect(getOffsetMinutes(new Date("2024-11-03T06:00:00Z"), "America/New_York")).toBe(-300) // 01:00 EST
  })

  it("an ambiguous wall time (01:30, occurs twice) resolves to a single instant", () => {
    const instant = zonedTimeToUtc(
      { year: 2024, month: 11, day: 3, hour: 1, minute: 30, second: 0 },
      "America/New_York",
    )
    // Deterministic single answer, and it reads back as 01:30 local.
    expect(utcToZonedParts(instant, "America/New_York")).toMatchObject({ hour: 1, minute: 30 })
    expect(["2024-11-03T05:30:00.000Z", "2024-11-03T06:30:00.000Z"]).toContain(instant.toISOString())
  })
})

describe("DST — Europe/London and Southern hemisphere", () => {
  it("London is UTC in winter, +1 (BST) in summer", () => {
    expect(getOffsetMinutes(new Date("2024-01-15T12:00:00Z"), "Europe/London")).toBe(0)
    expect(getOffsetMinutes(new Date("2024-07-15T12:00:00Z"), "Europe/London")).toBe(60)
  })

  it("Sydney runs opposite: +11 (DST) in Jan, +10 in Jul", () => {
    expect(getOffsetMinutes(new Date("2024-01-15T00:00:00Z"), "Australia/Sydney")).toBe(660)
    expect(getOffsetMinutes(new Date("2024-07-15T00:00:00Z"), "Australia/Sydney")).toBe(600)
  })

  it("India has no DST year-round", () => {
    expect(getOffsetMinutes(new Date("2024-01-15T00:00:00Z"), "Asia/Kolkata")).toBe(330)
    expect(getOffsetMinutes(new Date("2024-07-15T00:00:00Z"), "Asia/Kolkata")).toBe(330)
  })
})

describe("conversion round-trips and read helpers", () => {
  it("wallStringToUtc parses both space and T separators", () => {
    const a = wallStringToUtc("2024-06-01 09:30:00", "Asia/Kolkata")
    const b = wallStringToUtc("2024-06-01T09:30:00", "Asia/Kolkata")
    expect(a?.toISOString()).toBe("2024-06-01T04:00:00.000Z") // 09:30 IST - 5:30
    expect(a?.toISOString()).toBe(b?.toISOString())
  })

  it("wallStringToUtc returns null for garbage", () => {
    expect(wallStringToUtc("nonsense", "UTC")).toBeNull()
  })

  it("utcToWallString / zonedDateOnly project into the zone", () => {
    const instant = new Date("2024-06-01T20:00:00Z")
    expect(utcToWallString(instant, "Asia/Kolkata")).toBe("2024-06-02T01:30:00") // crosses midnight
    expect(zonedDateOnly(instant, "Asia/Kolkata")).toBe("2024-06-02")
    expect(zonedDateOnly(instant, "America/New_York")).toBe("2024-06-01")
  })

  it("toZonedIso emits an unambiguous instant with offset", () => {
    const instant = new Date("2024-06-01T04:00:00Z")
    expect(toZonedIso(instant, "Asia/Kolkata")).toBe("2024-06-01T09:30:00+05:30")
  })
})

describe("resolution hierarchy (tenant/user/entity/job/report)", () => {
  it("orders most-specific first", () => {
    expect(RESOLUTION_ORDER).toEqual(["report", "job", "entity", "user", "tenant", "default"])
  })

  it("report wins over everything below it", () => {
    expect(
      resolveTimeZone({
        report: "America/New_York",
        job: "Europe/London",
        entity: "Asia/Dubai",
        user: "Asia/Singapore",
        tenant: "Asia/Kolkata",
      }),
    ).toEqual({ timeZone: "America/New_York", source: "report" })
  })

  it("falls through invalid/empty layers to the next valid one", () => {
    expect(
      resolveTimeZone({ report: "Bad/Zone", job: null, entity: "  ", user: "Asia/Singapore", tenant: "Asia/Kolkata" }),
    ).toEqual({ timeZone: "Asia/Singapore", source: "user" })
  })

  it("uses tenant when only tenant is set", () => {
    expect(resolveTimeZone({ tenant: "Europe/London" })).toEqual({ timeZone: "Europe/London", source: "tenant" })
  })

  it("falls back to the ERP home zone when nothing valid is provided", () => {
    expect(resolveTimeZone({})).toEqual({ timeZone: DEFAULT_TIME_ZONE, source: "default" })
    expect(resolveTimeZone({ tenant: "Bad/Zone" })).toEqual({ timeZone: DEFAULT_TIME_ZONE, source: "default" })
  })

  it("honors a custom fallback", () => {
    expect(resolveTimeZone({}, "UTC")).toEqual({ timeZone: "UTC", source: "default" })
  })
})
