import { beforeEach, describe, expect, it, vi } from "vitest"

// SPEC 162 — Accounting Period Lock. These tests exercise the enforcement
// primitive (assertPeriodOpen / isPeriodLocked / periodKeyFor) and, critically,
// a set of BYPASS ATTEMPTS: differently-shaped inputs that all resolve to the
// same locked month must every one be rejected, so a locked period cannot be
// defeated by reformatting the date a client sends.

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  fiscalClosed: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mocks.query }))
vi.mock("@/lib/finance/fiscal-year", () => ({
  isFiscalPeriodClosedOrLocked: mocks.fiscalClosed,
}))

import {
  assertPeriodOpen,
  isPeriodLocked,
  periodKeyFor,
  PeriodLockedError,
} from "@/lib/finance-period-lock"

const LOCKED_MONTH = "2026-09"

/** Simulate a DB where only LOCKED_MONTH has a Locked row. */
function lockOnly(period: string) {
  mocks.query.mockImplementation(async (sql: string, args?: any[]) => {
    // CREATE TABLE (ensureSchema) and any non-select return nothing useful.
    if (/SELECT status FROM finance_period_locks/i.test(sql)) {
      return args?.[0] === period ? [{ status: "Locked" }] : []
    }
    return []
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fiscalClosed.mockResolvedValue(false)
  lockOnly(LOCKED_MONTH)
})

describe("periodKeyFor — date normalisation", () => {
  it("passes through a YYYY-MM key", () => {
    expect(periodKeyFor("2026-09")).toBe("2026-09")
  })
  it("reduces a full ISO date to its month", () => {
    expect(periodKeyFor("2026-09-15")).toBe("2026-09")
  })
  it("understands the accounting_period 'Mon-YYYY' form", () => {
    expect(periodKeyFor("Sep-2026")).toBe("2026-09")
  })
  it("returns empty for blank input", () => {
    expect(periodKeyFor(null)).toBe("")
    expect(periodKeyFor("")).toBe("")
  })
})

describe("isPeriodLocked", () => {
  it("is true for a locked month", async () => {
    expect(await isPeriodLocked("2026-09-01")).toBe(true)
  })
  it("is false for an open month", async () => {
    expect(await isPeriodLocked("2026-10-01")).toBe(false)
  })
  it("also seals a month closed by the fiscal-year engine (SPEC 161)", async () => {
    lockOnly("____none____") // no period-lock rows at all
    mocks.fiscalClosed.mockResolvedValue(true)
    expect(await isPeriodLocked("2026-05-01")).toBe(true)
  })
})

describe("assertPeriodOpen", () => {
  it("throws PeriodLockedError for a locked month", async () => {
    await expect(assertPeriodOpen("2026-09-30")).rejects.toBeInstanceOf(PeriodLockedError)
  })
  it("carries the resolved period on the error", async () => {
    await expect(assertPeriodOpen("2026-09-30")).rejects.toMatchObject({ period: LOCKED_MONTH })
  })
  it("passes for an open month", async () => {
    await expect(assertPeriodOpen("2026-10-30")).resolves.toBeUndefined()
  })
  it("passes for blank/no date (nothing to seal)", async () => {
    await expect(assertPeriodOpen(null)).resolves.toBeUndefined()
    await expect(assertPeriodOpen("")).resolves.toBeUndefined()
  })
})

describe("bypass attempts — every alias of a locked month is rejected", () => {
  // A client cannot slip a transaction into a locked month by reshaping the
  // date it submits: all of these resolve to 2026-09 and must be blocked.
  const aliases = [
    "2026-09",
    "2026-09-01",
    "2026-09-15",
    "2026-09-30",
    "Sep-2026",
    "2026-09-30T23:59:59.000Z",
  ]
  for (const value of aliases) {
    it(`rejects ${JSON.stringify(value)}`, async () => {
      await expect(assertPeriodOpen(value)).rejects.toBeInstanceOf(PeriodLockedError)
    })
  }

  it("still allows an adjacent open month (no over-blocking)", async () => {
    await expect(assertPeriodOpen("2026-08-31")).resolves.toBeUndefined()
    await expect(assertPeriodOpen("2026-10-01")).resolves.toBeUndefined()
  })
})
