import { describe, expect, it } from "vitest"
import {
  LEGAL_HOLD_SCOPES,
  describeHoldItem,
  isFileHeld,
  isLegalHoldScope,
  isLegalHoldStatus,
  isPolicyFullyHeld,
  isRecordHeld,
  itemHoldsFile,
  itemHoldsRecord,
  itemTargetsPolicy,
  normalizeHoldInput,
  normalizeHoldItemInput,
  toLegalHoldStatus,
  type FileEvaluable,
  type HoldEvaluable,
  type LegalHoldItemMatch,
  type LegalHoldScope,
  type PolicyTarget,
} from "@/lib/legal-hold-model"

/**
 * SPEC 72 — Phase 4. Pure, DB-free validation of the legal-hold model: the
 * predicates the automated deletion services (SPEC 71 record retention engine
 * and SPEC 36 storage retention sweep) consult to guarantee that held data is
 * never destroyed. A hold ALWAYS wins over any retention policy, so these tests
 * are the contract that proves deletion prevention.
 */

// ---------------------------------------------------------------------------
// Test helpers — build a normalized item match with only the fields a case needs
// ---------------------------------------------------------------------------

function match(overrides: Partial<LegalHoldItemMatch> & { scope: LegalHoldScope }): LegalHoldItemMatch {
  return {
    module: null,
    catalogKey: null,
    recordType: null,
    recordRef: null,
    matchField: null,
    matchValue: null,
    fileId: null,
    ...overrides,
  }
}

const financePolicy: PolicyTarget = {
  module: "Finance",
  catalogKey: "finance.sales_invoices",
  recordType: "Closed invoices",
}

// ---------------------------------------------------------------------------
// Scope & status guards
// ---------------------------------------------------------------------------

describe("scope & status guards", () => {
  it("recognises every valid scope and nothing else", () => {
    for (const s of LEGAL_HOLD_SCOPES) expect(isLegalHoldScope(s)).toBe(true)
    expect(isLegalHoldScope("row")).toBe(false)
    expect(isLegalHoldScope(null)).toBe(false)
    expect(isLegalHoldScope(42)).toBe(false)
  })

  it("recognises valid statuses and coerces unknowns to active", () => {
    expect(isLegalHoldStatus("active")).toBe(true)
    expect(isLegalHoldStatus("released")).toBe(true)
    expect(isLegalHoldStatus("archived")).toBe(false)
    expect(toLegalHoldStatus("released")).toBe("released")
    expect(toLegalHoldStatus("garbage")).toBe("active")
    expect(toLegalHoldStatus(undefined)).toBe("active")
  })
})

// ---------------------------------------------------------------------------
// itemTargetsPolicy — precedence: module scope, catalog key, module+type, module
// ---------------------------------------------------------------------------

describe("itemTargetsPolicy", () => {
  it("a module-scoped item guards every policy in that module", () => {
    expect(itemTargetsPolicy(match({ scope: "module", module: "Finance" }), financePolicy)).toBe(true)
    expect(itemTargetsPolicy(match({ scope: "module", module: "HR" }), financePolicy)).toBe(false)
  })

  it("prefers exact catalog-key equality when both sides have one", () => {
    expect(
      itemTargetsPolicy(match({ scope: "record_type", catalogKey: "finance.sales_invoices" }), financePolicy),
    ).toBe(true)
    // A different catalog key does not match even inside the same module.
    expect(
      itemTargetsPolicy(
        match({ scope: "record_type", module: "Finance", catalogKey: "finance.expenses" }),
        financePolicy,
      ),
    ).toBe(false)
  })

  it("falls back to module + record-type label equality", () => {
    expect(
      itemTargetsPolicy(
        match({ scope: "record_type", module: "Finance", recordType: "Closed invoices" }),
        financePolicy,
      ),
    ).toBe(true)
    expect(
      itemTargetsPolicy(
        match({ scope: "record_type", module: "Finance", recordType: "Open invoices" }),
        financePolicy,
      ),
    ).toBe(false)
  })

  it("a record-family item carrying only a module label still guards that module", () => {
    expect(itemTargetsPolicy(match({ scope: "record", module: "Finance", recordRef: "1" }), financePolicy)).toBe(true)
  })

  it("a file-scoped item never targets a retention policy", () => {
    expect(itemTargetsPolicy(match({ scope: "file", fileId: 1, module: "Finance" }), financePolicy)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isPolicyFullyHeld — a module/record_type hold skips the WHOLE sweep
// ---------------------------------------------------------------------------

describe("isPolicyFullyHeld", () => {
  it("is true when a module-scoped hold covers the policy's module", () => {
    expect(isPolicyFullyHeld([match({ scope: "module", module: "Finance" })], financePolicy)).toBe(true)
  })

  it("is true when a record_type hold matches by catalog key", () => {
    expect(
      isPolicyFullyHeld([match({ scope: "record_type", catalogKey: "finance.sales_invoices" })], financePolicy),
    ).toBe(true)
  })

  it("is false for row-level (record/criteria) holds — those carve out rows, not the policy", () => {
    expect(
      isPolicyFullyHeld(
        [
          match({ scope: "record", module: "Finance", recordRef: "5" }),
          match({ scope: "criteria", module: "Finance", matchField: "region", matchValue: "EU" }),
        ],
        financePolicy,
      ),
    ).toBe(false)
  })

  it("is false when no active item targets the policy", () => {
    expect(isPolicyFullyHeld([match({ scope: "module", module: "HR" })], financePolicy)).toBe(false)
    expect(isPolicyFullyHeld([], financePolicy)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// itemHoldsRecord / isRecordHeld — row-level deletion prevention
// ---------------------------------------------------------------------------

describe("record-level holds", () => {
  const record: HoldEvaluable = { id: 42, fields: { region: "EU", status: "Closed" } }

  it("a record-scoped hold protects exactly its referenced id", () => {
    const item = match({ scope: "record", catalogKey: "finance.sales_invoices", recordRef: "42" })
    expect(itemHoldsRecord(item, financePolicy, record)).toBe(true)
    expect(itemHoldsRecord(item, financePolicy, { id: 7, fields: {} })).toBe(false)
  })

  it("coerces id types so a numeric id matches a string ref", () => {
    const item = match({ scope: "record", catalogKey: "finance.sales_invoices", recordRef: "42" })
    expect(itemHoldsRecord(item, financePolicy, { id: "42", fields: {} })).toBe(true)
  })

  it("a criteria-scoped hold protects every record whose field equals the value", () => {
    const item = match({
      scope: "criteria",
      catalogKey: "finance.sales_invoices",
      matchField: "region",
      matchValue: "EU",
    })
    expect(itemHoldsRecord(item, financePolicy, record)).toBe(true)
    expect(itemHoldsRecord(item, financePolicy, { id: 9, fields: { region: "US" } })).toBe(false)
    expect(itemHoldsRecord(item, financePolicy, { id: 9, fields: {} })).toBe(false)
  })

  it("does not hold records of a different policy family", () => {
    const item = match({ scope: "record", catalogKey: "finance.expenses", recordRef: "42" })
    expect(itemHoldsRecord(item, financePolicy, record)).toBe(false)
  })

  it("family-scoped items are not row-level predicates", () => {
    const item = match({ scope: "module", module: "Finance" })
    expect(itemHoldsRecord(item, financePolicy, record)).toBe(false)
  })

  it("isRecordHeld is true when ANY active item holds the record", () => {
    const items = [
      match({ scope: "record", catalogKey: "finance.sales_invoices", recordRef: "1" }),
      match({ scope: "criteria", catalogKey: "finance.sales_invoices", matchField: "status", matchValue: "Closed" }),
    ]
    expect(isRecordHeld(items, financePolicy, record)).toBe(true)
    expect(isRecordHeld([items[0]], financePolicy, record)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// itemHoldsFile / isFileHeld — storage deletion prevention
// ---------------------------------------------------------------------------

describe("file-level holds", () => {
  const file: FileEvaluable = { id: 500, module: "Finance" }

  it("a file-scoped hold protects exactly its file id", () => {
    expect(itemHoldsFile(match({ scope: "file", fileId: 500 }), file)).toBe(true)
    expect(itemHoldsFile(match({ scope: "file", fileId: 501 }), file)).toBe(false)
  })

  it("a module-scoped hold protects every file in that module", () => {
    expect(itemHoldsFile(match({ scope: "module", module: "Finance" }), file)).toBe(true)
    expect(itemHoldsFile(match({ scope: "module", module: "HR" }), file)).toBe(false)
  })

  it("record/record_type/criteria holds never protect a file", () => {
    expect(itemHoldsFile(match({ scope: "record", module: "Finance", recordRef: "1" }), file)).toBe(false)
    expect(itemHoldsFile(match({ scope: "record_type", catalogKey: "finance.sales_invoices" }), file)).toBe(false)
    expect(itemHoldsFile(match({ scope: "criteria", matchField: "x", matchValue: "y" }), file)).toBe(false)
  })

  it("isFileHeld is true when ANY active item holds the file", () => {
    const items = [match({ scope: "file", fileId: 999 }), match({ scope: "module", module: "Finance" })]
    expect(isFileHeld(items, file)).toBe(true)
    expect(isFileHeld([match({ scope: "file", fileId: 999 })], file)).toBe(false)
    expect(isFileHeld([], file)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Input normalization — the API's 400 contract
// ---------------------------------------------------------------------------

describe("normalizeHoldInput", () => {
  it("trims and requires a name, keeping reason optional", () => {
    expect(normalizeHoldInput({ name: "  Matter A  ", reason: " litigation " })).toEqual({
      name: "Matter A",
      reason: "litigation",
    })
    expect(normalizeHoldInput({ name: "Matter B" })).toEqual({ name: "Matter B", reason: null })
  })

  it("throws when the name is missing or blank", () => {
    expect(() => normalizeHoldInput({ name: "   " })).toThrow(/name is required/i)
    expect(() => normalizeHoldInput({})).toThrow(/name is required/i)
  })

  it("slices oversized fields to the column limits", () => {
    const long = "x".repeat(1500)
    const out = normalizeHoldInput({ name: long, reason: long })
    expect(out.name.length).toBe(200)
    expect(out.reason?.length).toBe(1000)
  })
})

describe("normalizeHoldItemInput", () => {
  it("rejects an invalid scope", () => {
    expect(() => normalizeHoldItemInput({ scope: "row" })).toThrow(/valid hold scope/i)
  })

  it("module scope requires a module", () => {
    expect(() => normalizeHoldItemInput({ scope: "module" })).toThrow(/module is required/i)
    expect(normalizeHoldItemInput({ scope: "module", module: "Finance" }).module).toBe("Finance")
  })

  it("record_type requires a catalog key or module", () => {
    expect(() => normalizeHoldItemInput({ scope: "record_type" })).toThrow(/record type/i)
    expect(normalizeHoldItemInput({ scope: "record_type", catalogKey: "finance.sales_invoices" }).catalogKey).toBe(
      "finance.sales_invoices",
    )
  })

  it("record scope requires a family target and a record reference", () => {
    expect(() => normalizeHoldItemInput({ scope: "record", module: "Finance" })).toThrow(/record reference/i)
    expect(() => normalizeHoldItemInput({ scope: "record", recordRef: "5" })).toThrow(/record type/i)
    const ok = normalizeHoldItemInput({ scope: "record", module: "Finance", recordRef: "5", note: "keep" })
    expect(ok.recordRef).toBe("5")
    expect(ok.note).toBe("keep")
  })

  it("criteria scope requires a family target and a match field", () => {
    expect(() => normalizeHoldItemInput({ scope: "criteria", module: "Finance" })).toThrow(/field is required/i)
    const ok = normalizeHoldItemInput({
      scope: "criteria",
      module: "Finance",
      matchField: "region",
      matchValue: "EU",
    })
    expect(ok.matchField).toBe("region")
    expect(ok.matchValue).toBe("EU")
  })

  it("file scope requires a positive file id", () => {
    expect(() => normalizeHoldItemInput({ scope: "file" })).toThrow(/file id is required/i)
    expect(() => normalizeHoldItemInput({ scope: "file", fileId: 0 })).toThrow(/file id is required/i)
    expect(() => normalizeHoldItemInput({ scope: "file", fileId: -3 })).toThrow(/file id is required/i)
    expect(normalizeHoldItemInput({ scope: "file", fileId: "12" }).fileId).toBe(12)
  })
})

// ---------------------------------------------------------------------------
// describeHoldItem — audit / UI label surface
// ---------------------------------------------------------------------------

describe("describeHoldItem", () => {
  it("renders a human label per scope", () => {
    expect(describeHoldItem(normalizeHoldItemInput({ scope: "module", module: "Finance" }))).toBe("Module: Finance")
    expect(
      describeHoldItem(normalizeHoldItemInput({ scope: "record", module: "Finance", recordRef: "42" })),
    ).toContain("Record 42")
    expect(
      describeHoldItem(
        normalizeHoldItemInput({ scope: "criteria", module: "Finance", matchField: "region", matchValue: "EU" }),
      ),
    ).toContain("region = EU")
    expect(describeHoldItem(normalizeHoldItemInput({ scope: "file", fileId: 7 }))).toBe("File #7")
  })
})
