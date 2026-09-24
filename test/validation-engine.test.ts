import { describe, it, expect } from "vitest"
import {
  checkFormat,
  collectUniqueChecks,
  evaluateCondition,
  field,
  rule,
  uniqueKey,
  validateRecord,
  type BusinessRuleFn,
  type ValidationSchema,
} from "@/lib/validation/model"

/**
 * SPEC 102 Phase 4. The validation engine is the single source of truth for
 * "is this data acceptable" across APIs, forms and imports, so the whole
 * feature's correctness rests on this pure model. These tests pin each of the
 * seven validation kinds — Required, Format, Range, Uniqueness, Cross-field,
 * Conditional and Business-rule — so a regression can never silently accept bad
 * data or reject good data.
 */

// ---------------------------------------------------------------------------
// Named formats
// ---------------------------------------------------------------------------

describe("checkFormat", () => {
  it("validates emails", () => {
    expect(checkFormat("email", "a@b.com")).toBe(true)
    expect(checkFormat("email", "nope")).toBe(false)
  })
  it("validates phones ignoring punctuation", () => {
    expect(checkFormat("phone", "+91 (988) 776-6554")).toBe(true)
    expect(checkFormat("phone", "12")).toBe(false)
  })
  it("validates Indian tax + bank formats (shape only)", () => {
    expect(checkFormat("pan", "ABCDE1234F")).toBe(true)
    expect(checkFormat("pan", "ABCDE1234")).toBe(false)
    expect(checkFormat("gstin", "22ABCDE1234F1Z5")).toBe(true)
    expect(checkFormat("gstin", "22ABCDE1234F1Z")).toBe(false)
    expect(checkFormat("ifsc", "HDFC0001234")).toBe(true)
    expect(checkFormat("ifsc", "HDFC1001234")).toBe(false)
    expect(checkFormat("pincode", "560001")).toBe(true)
    expect(checkFormat("pincode", "000123")).toBe(false)
  })
  it("validates urls, uuids and real calendar dates", () => {
    expect(checkFormat("url", "https://v0.app/x")).toBe(true)
    expect(checkFormat("url", "ftp://x")).toBe(false)
    expect(checkFormat("uuid", "3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(true)
    expect(checkFormat("date", "2024-02-29")).toBe(true) // leap year
    expect(checkFormat("date", "2023-02-29")).toBe(false) // not a leap year
    expect(checkFormat("date", "2024-13-01")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

describe("evaluateCondition", () => {
  const rec = { type: "company", amount: 500, country: "IN", tags: ["a", "b"] }

  it("handles equality, membership and presence", () => {
    expect(evaluateCondition({ field: "type", op: "eq", value: "company" }, rec)).toBe(true)
    expect(evaluateCondition({ field: "country", op: "in", value: ["IN", "US"] }, rec)).toBe(true)
    expect(evaluateCondition({ field: "missing", op: "empty" }, rec)).toBe(true)
    expect(evaluateCondition({ field: "type", op: "notEmpty" }, rec)).toBe(true)
  })

  it("handles numeric ordering", () => {
    expect(evaluateCondition({ field: "amount", op: "gt", value: 100 }, rec)).toBe(true)
    expect(evaluateCondition({ field: "amount", op: "lt", value: 100 }, rec)).toBe(false)
  })

  it("composes with all / any / not", () => {
    expect(
      evaluateCondition(
        { all: [{ field: "type", op: "eq", value: "company" }, { field: "amount", op: "gte", value: 500 }] },
        rec,
      ),
    ).toBe(true)
    expect(evaluateCondition({ not: { field: "type", op: "eq", value: "company" } }, rec)).toBe(false)
    expect(evaluateCondition({ any: [{ field: "type", op: "eq", value: "x" }, { field: "country", op: "eq", value: "IN" }] }, rec)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Required + Format + Range field rules
// ---------------------------------------------------------------------------

const schema: ValidationSchema = {
  entity: "customer",
  fields: [
    field("name", "Name", [rule.required(), rule.length(2, 80)]),
    field("email", "Email", [rule.required(), rule.format("email"), rule.unique("email")]),
    field("age", "Age", [rule.range(18, 120)]),
    field("website", "Website", [rule.format("url")]),
    field("gstin", "GSTIN", [rule.format("gstin")], { when: { field: "country", op: "eq", value: "IN" } }),
  ],
  crossField: [
    { type: "cross-field", field: "endDate", op: "after", other: "startDate", as: "date", message: "End date must be after start date." },
  ],
  businessRules: [{ type: "business-rule", name: "creditLimitPolicy", fields: ["creditLimit"] }],
}

describe("validateRecord — required & format & range", () => {
  it("passes a fully valid record", () => {
    const r = validateRecord(schema, { name: "Acme", email: "ops@acme.com", age: 30 })
    expect(r.ok).toBe(true)
    expect(r.issues).toHaveLength(0)
  })

  it("flags missing required fields", () => {
    const r = validateRecord(schema, { email: "ops@acme.com" })
    expect(r.ok).toBe(false)
    expect(r.fieldErrors.name?.[0]).toMatch(/required/i)
  })

  it("skips format + range on blank optional fields", () => {
    const r = validateRecord(schema, { name: "Acme", email: "ops@acme.com" })
    expect(r.ok).toBe(true) // age and website are absent → not checked
  })

  it("enforces format and range when present", () => {
    const r = validateRecord(schema, { name: "Acme", email: "bad", age: 5, website: "nope" })
    expect(r.ok).toBe(false)
    expect(r.fieldErrors.email?.[0]).toMatch(/email/i)
    expect(r.fieldErrors.age?.[0]).toMatch(/minimum/i)
    expect(r.fieldErrors.website?.[0]).toMatch(/url/i)
  })

  it("trims strings before checking length/required", () => {
    const r = validateRecord(schema, { name: "   ", email: "ops@acme.com" })
    expect(r.fieldErrors.name?.[0]).toMatch(/required/i)
  })

  it("collects all messages and exposes firstErrors for the API envelope", () => {
    const r = validateRecord(schema, { email: "bad" })
    expect(Object.keys(r.firstErrors)).toContain("name")
    expect(Object.keys(r.firstErrors)).toContain("email")
    expect(r.firstErrors.email).toBe(r.fieldErrors.email[0])
  })
})

// ---------------------------------------------------------------------------
// Conditional validation
// ---------------------------------------------------------------------------

describe("validateRecord — conditional", () => {
  it("only enforces GSTIN format for Indian customers", () => {
    const nonIndian = validateRecord(schema, { name: "Acme", email: "ops@acme.com", country: "US", gstin: "garbage" })
    expect(nonIndian.ok).toBe(true) // rule skipped: country != IN

    const indianBad = validateRecord(schema, { name: "Acme", email: "ops@acme.com", country: "IN", gstin: "garbage" })
    expect(indianBad.ok).toBe(false)
    expect(indianBad.fieldErrors.gstin?.[0]).toMatch(/gstin/i)

    const indianGood = validateRecord(schema, { name: "Acme", email: "ops@acme.com", country: "IN", gstin: "22ABCDE1234F1Z5" })
    expect(indianGood.ok).toBe(true)
  })

  it("supports rule-level conditions", () => {
    const s: ValidationSchema = {
      entity: "x",
      fields: [field("po", "PO Number", [{ type: "required", when: { field: "requiresPo", op: "truthy" } }])],
    }
    expect(validateRecord(s, { requiresPo: false }).ok).toBe(true)
    expect(validateRecord(s, { requiresPo: true }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

describe("validateRecord — cross-field", () => {
  it("passes when end date is after start date", () => {
    const r = validateRecord(schema, { name: "Ab", email: "a@b.com", startDate: "2024-01-01", endDate: "2024-06-01" })
    expect(r.ok).toBe(true)
  })
  it("fails when end date is before start date", () => {
    const r = validateRecord(schema, { name: "Ab", email: "a@b.com", startDate: "2024-06-01", endDate: "2024-01-01" })
    expect(r.ok).toBe(false)
    expect(r.fieldErrors.endDate?.[0]).toMatch(/after start/i)
  })
  it("does not fire on half-filled data", () => {
    const r = validateRecord(schema, { name: "Ab", email: "a@b.com", startDate: "2024-06-01" })
    expect(r.ok).toBe(true) // endDate blank → skipped
  })
})

// ---------------------------------------------------------------------------
// Uniqueness (declaration + engine consumption)
// ---------------------------------------------------------------------------

describe("uniqueness", () => {
  it("collects the checks a record actually needs, skipping blanks", () => {
    const checks = collectUniqueChecks(schema, { name: "Acme", email: "ops@acme.com" })
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ field: "email", scope: "email", value: "ops@acme.com" })

    expect(collectUniqueChecks(schema, { name: "Acme" })).toHaveLength(0) // email blank
  })

  it("raises a uniqueness error when the resolver reports a duplicate", () => {
    const taken = { [uniqueKey("email", "email")]: true }
    const r = validateRecord(schema, { name: "Acme", email: "ops@acme.com" }, { duplicates: taken })
    expect(r.ok).toBe(false)
    expect(r.fieldErrors.email?.[0]).toMatch(/already in use/i)
  })

  it("passes when the value is not taken", () => {
    const free = { [uniqueKey("email", "email")]: false }
    const r = validateRecord(schema, { name: "Acme", email: "ops@acme.com" }, { duplicates: free })
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Business-rule validation
// ---------------------------------------------------------------------------

describe("business rules", () => {
  const creditLimitPolicy: BusinessRuleFn = (record) => {
    const tier = String(record.tier ?? "")
    const limit = Number(record.creditLimit ?? 0)
    if (tier === "basic" && limit > 1000) {
      return { ok: false, message: "Basic tier customers cannot exceed a 1,000 credit limit." }
    }
    return true
  }

  it("passes when the named rule is satisfied", () => {
    const r = validateRecord(
      schema,
      { name: "Ab", email: "a@b.com", tier: "basic", creditLimit: 500 },
      { businessRules: { creditLimitPolicy } },
    )
    expect(r.ok).toBe(true)
  })

  it("attaches the failure to the declared field", () => {
    const r = validateRecord(
      schema,
      { name: "Ab", email: "a@b.com", tier: "basic", creditLimit: 5000 },
      { businessRules: { creditLimitPolicy } },
    )
    expect(r.ok).toBe(false)
    expect(r.fieldErrors.creditLimit?.[0]).toMatch(/1,000 credit limit/)
  })

  it("treats an unregistered rule as a no-op (never a hard crash)", () => {
    const r = validateRecord(schema, { name: "Ab", email: "a@b.com" }, { businessRules: {} })
    expect(r.ok).toBe(true)
  })

  it("supports field-scoped error maps from a rule", () => {
    const multi: BusinessRuleFn = () => ({ ok: false, fieldErrors: { a: "bad a", b: "bad b" } })
    const s: ValidationSchema = { entity: "x", fields: [], businessRules: [{ type: "business-rule", name: "multi" }] }
    const r = validateRecord(s, {}, { businessRules: { multi } })
    expect(r.fieldErrors.a?.[0]).toBe("bad a")
    expect(r.fieldErrors.b?.[0]).toBe("bad b")
  })
})
