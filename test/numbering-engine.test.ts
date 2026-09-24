import { describe, it, expect } from "vitest"
import {
  advanceCounter,
  clampFiscalMonth,
  clampPadding,
  defaultRuleFor,
  fiscalYearLabel,
  fiscalYearStart,
  normalizeEntity,
  renderNumber,
  resetPeriodKey,
  validateRuleInput,
  type NumberingRule,
} from "@/lib/numbering/model"

const rule = (over: Partial<NumberingRule> = {}): NumberingRule => ({
  entity: "EMP",
  prefix: "EMP",
  suffix: "",
  padding: 6,
  reset: "yearly",
  format: "{PREFIX}-{YYYY}-{SEQ}",
  fiscalStartMonth: 4,
  startNumber: 1,
  ...over,
})

describe("SPEC 92 — rendering (spec examples)", () => {
  it("renders EMP-2026-000001", () => {
    expect(renderNumber(rule(), 1, new Date("2026-06-15T00:00:00Z"))).toBe("EMP-2026-000001")
  })

  it("renders INV-2026-000001", () => {
    const r = rule({ entity: "INV", prefix: "INV" })
    expect(renderNumber(r, 1, new Date("2026-01-01T00:00:00Z"))).toBe("INV-2026-000001")
  })

  it("renders VEN-000001 (no year, never reset)", () => {
    const r = rule({ entity: "VEN", prefix: "VEN", reset: "never", format: "{PREFIX}-{SEQ}" })
    expect(renderNumber(r, 1)).toBe("VEN-000001")
  })

  it("honors padding and suffix and unknown-token passthrough", () => {
    const r = rule({ prefix: "X", suffix: "Z", padding: 3, format: "{PREFIX}/{SEQ}/{SUFFIX}/{NOPE}" })
    expect(renderNumber(r, 42)).toBe("X/042/Z/{NOPE}")
  })
})

describe("SPEC 92 — fiscal year", () => {
  it("buckets by fiscal year with April start", () => {
    expect(fiscalYearStart(new Date("2026-03-31T00:00:00Z"), 4)).toBe(2025)
    expect(fiscalYearStart(new Date("2026-04-01T00:00:00Z"), 4)).toBe(2026)
  })

  it("labels a spanning fiscal year", () => {
    expect(fiscalYearLabel(new Date("2026-05-01T00:00:00Z"), 4)).toBe("2026-27")
  })

  it("collapses a January fiscal start to the plain year", () => {
    expect(fiscalYearLabel(new Date("2026-05-01T00:00:00Z"), 1)).toBe("2026")
  })
})

describe("SPEC 92 — reset period keys", () => {
  const d = new Date("2026-07-09T00:00:00Z")
  it("never → single bucket", () => expect(resetPeriodKey(rule({ reset: "never" }), d)).toBe("ALL"))
  it("yearly → calendar year", () => expect(resetPeriodKey(rule({ reset: "yearly" }), d)).toBe("2026"))
  it("fiscal → fiscal-year bucket", () => expect(resetPeriodKey(rule({ reset: "fiscal" }), d)).toBe("FY2026"))
  it("monthly → year-month", () => expect(resetPeriodKey(rule({ reset: "monthly" }), d)).toBe("2026-07"))
  it("daily → year-month-day", () => expect(resetPeriodKey(rule({ reset: "daily" }), d)).toBe("2026-07-09"))

  it("rolls the bucket over at the period boundary", () => {
    const r = rule({ reset: "yearly" })
    expect(resetPeriodKey(r, new Date("2026-12-31T23:59:59Z"))).toBe("2026")
    expect(resetPeriodKey(r, new Date("2027-01-01T00:00:00Z"))).toBe("2027")
  })
})

describe("SPEC 92 — sequence advance (duplicate prevention core)", () => {
  it("starts a fresh period at startNumber", () => {
    expect(advanceCounter(null, 1)).toBe(1)
    expect(advanceCounter(undefined, 500)).toBe(500)
  })

  it("is strictly monotonic thereafter", () => {
    expect(advanceCounter(1, 1)).toBe(2)
    expect(advanceCounter(999, 1)).toBe(1000)
  })

  it("mirrors the DB INSERT..ON DUPLICATE KEY semantics over a run", () => {
    // Simulate the exact row the engine's SQL would settle on across a burst of
    // concurrent allocations against one counter: no value is ever repeated.
    let stored: number | null = null
    const handed: number[] = []
    for (let i = 0; i < 1000; i++) {
      const next = advanceCounter(stored, 1)
      stored = next
      handed.push(next)
    }
    expect(handed[0]).toBe(1)
    expect(handed.at(-1)).toBe(1000)
    expect(new Set(handed).size).toBe(handed.length) // zero duplicates
    // strictly increasing by exactly 1
    for (let i = 1; i < handed.length; i++) expect(handed[i] - handed[i - 1]).toBe(1)
  })

  it("produces unique rendered ids across a period", () => {
    const r = rule({ reset: "yearly" })
    const date = new Date("2026-02-02T00:00:00Z")
    const ids = new Set<string>()
    let stored: number | null = null
    for (let i = 0; i < 250; i++) {
      stored = advanceCounter(stored, r.startNumber)
      ids.add(renderNumber(r, stored, date))
    }
    expect(ids.size).toBe(250)
    expect(ids.has("EMP-2026-000001")).toBe(true)
    expect(ids.has("EMP-2026-000250")).toBe(true)
  })
})

describe("SPEC 92 — validation guards", () => {
  it("rejects a format without {SEQ}", () => {
    const res = validateRuleInput({ entity: "EMP", format: "{PREFIX}-{YYYY}" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/\{SEQ\}/)
  })

  it("rejects unknown tokens", () => {
    const res = validateRuleInput({ entity: "EMP", format: "{PREFIX}-{SEQ}-{WAT}" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/WAT/)
  })

  it("rejects an empty entity and a negative start number", () => {
    expect(validateRuleInput({ entity: "!!!" }).ok).toBe(false)
    expect(validateRuleInput({ entity: "EMP", startNumber: -3 }).ok).toBe(false)
  })

  it("normalizes and clamps a valid rule", () => {
    const res = validateRuleInput({
      entity: "emp-1",
      prefix: " emp ",
      padding: 99,
      reset: "fiscal",
      fiscalStartMonth: 13,
      format: "{PREFIX}-{SEQ}",
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.rule.entity).toBe("EMP1")
      expect(res.rule.prefix).toBe("emp")
      expect(res.rule.padding).toBe(12)
      expect(res.rule.fiscalStartMonth).toBe(4)
    }
  })
})

describe("SPEC 92 — helpers & catalogue", () => {
  it("clamps padding and fiscal month", () => {
    expect(clampPadding(0)).toBe(1)
    expect(clampPadding(50)).toBe(12)
    expect(clampFiscalMonth(0)).toBe(4)
    expect(clampFiscalMonth(7)).toBe(7)
  })

  it("normalizes entity keys", () => {
    expect(normalizeEntity(" inv-2026 ")).toBe("INV2026")
  })

  it("provides catalogue defaults and a generic fallback", () => {
    expect(defaultRuleFor("EMP").format).toBe("{PREFIX}-{YYYY}-{SEQ}")
    const fallback = defaultRuleFor("zzz")
    expect(fallback.prefix).toBe("ZZZ")
    expect(fallback.reset).toBe("never")
  })
})
