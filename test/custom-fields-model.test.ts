import { describe, it, expect } from "vitest"
import {
  canEditField,
  canViewField,
  checkFormula,
  evaluateFormula,
  extractFormulaRefs,
  normalizeFieldKey,
  numericValueOf,
  validateFieldDef,
  validateFieldValue,
  type FieldDefinition,
  type FieldDefInput,
} from "@/lib/custom-fields/model"

/**
 * Phase 4. The custom-field engine lets tenants define arbitrary fields at
 * runtime, so the whole feature's safety rests on the pure model: definition
 * validation, per-value validation, the injection-proof formula engine and the
 * fail-safe permission ordering. These tests pin that model (no DB / server-only
 * imports) so a regression can never silently accept a bad definition, store an
 * invalid value, evaluate an unsafe formula, or widen field access.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function def(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    entityType: "contact",
    key: "field",
    label: "Field",
    type: "text",
    required: false,
    options: [],
    config: {},
    defaultValue: null,
    helpText: "",
    viewMinRole: "employee",
    editMinRole: "employee",
    active: true,
    sortOrder: 0,
    ...overrides,
  }
}

function makeDef(input: FieldDefInput, siblings: string[] = []) {
  return validateFieldDef(input, siblings)
}

// ---------------------------------------------------------------------------
// Key normalization
// ---------------------------------------------------------------------------

describe("normalizeFieldKey", () => {
  it("lowercases, collapses separators and trims underscores", () => {
    expect(normalizeFieldKey("  Contract Value! ")).toBe("contract_value")
  })
  it("prefixes keys that would start with a digit", () => {
    expect(normalizeFieldKey("2024 total")).toBe("f_2024_total")
  })
  it("returns empty for junk", () => {
    expect(normalizeFieldKey("***")).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Definition validation
// ---------------------------------------------------------------------------

describe("validateFieldDef", () => {
  it("accepts a minimal text field and derives its key from the label", () => {
    const r = makeDef({ entityType: "contact", label: "Nickname", type: "text" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.def.key).toBe("nickname")
  })

  it("rejects an unknown entity type", () => {
    const r = makeDef({ entityType: "dragon", label: "X", type: "text" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/entity/i)
  })

  it("rejects an unknown field type", () => {
    const r = makeDef({ entityType: "contact", label: "X", type: "rainbow" })
    expect(r.ok).toBe(false)
  })

  it("requires options for choice fields", () => {
    const r = makeDef({ entityType: "contact", label: "Stage", type: "dropdown", options: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/option/i)
  })

  it("requires and validates a target entity for entity fields", () => {
    const bad = makeDef({ entityType: "deal", label: "Primary contact", type: "entity" })
    expect(bad.ok).toBe(false)
    const good = makeDef({
      entityType: "deal",
      label: "Primary contact",
      type: "entity",
      config: { targetEntity: "contact" },
    })
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.def.config.targetEntity).toBe("contact")
  })

  it("rejects a currency with a non-ISO code and min > max", () => {
    const r = makeDef({
      entityType: "deal",
      label: "Value",
      type: "currency",
      config: { currencyCode: "dollars", min: 10, max: 5 },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.join(" ")).toMatch(/currency code/i)
      expect(r.errors.join(" ")).toMatch(/minimum/i)
    }
  })

  it("forces computed fields to be non-required", () => {
    const r = makeDef(
      { entityType: "deal", label: "Total", type: "formula", required: true, config: { formula: "qty" } },
      ["qty"],
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.def.required).toBe(false)
  })

  it("refuses edit access broader than view access (fail-safe ordering)", () => {
    const r = makeDef({
      entityType: "contact",
      label: "Salary",
      type: "number",
      viewMinRole: "tenant_admin",
      editMinRole: "employee",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/edit access cannot be broader/i)
  })
})

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

describe("validateFieldValue", () => {
  it("enforces required", () => {
    const r = validateFieldValue(def({ required: true }), "")
    expect(r.ok).toBe(false)
  })

  it("allows blank when optional and yields null", () => {
    const r = validateFieldValue(def({ required: false }), "")
    expect(r).toEqual({ ok: true, value: null })
  })

  it("validates url protocol", () => {
    expect(validateFieldValue(def({ type: "url" }), "ftp://x").ok).toBe(false)
    expect(validateFieldValue(def({ type: "url" }), "https://v0.app").ok).toBe(true)
  })

  it("rounds numbers to precision and enforces bounds", () => {
    const d = def({ type: "number", config: { min: 0, max: 10, precision: 2 } })
    const r = validateFieldValue(d, 3.14159)
    expect(r).toEqual({ ok: true, value: 3.14 })
    expect(validateFieldValue(d, 11).ok).toBe(false)
    expect(validateFieldValue(d, -1).ok).toBe(false)
  })

  it("shapes a currency value with amount + code", () => {
    const d = def({ type: "currency", config: { currencyCode: "EUR", precision: 2 } })
    const r = validateFieldValue(d, 9.999)
    expect(r).toEqual({ ok: true, value: { amount: 10, currency: "EUR" } })
  })

  it("accepts a currency object payload", () => {
    const d = def({ type: "currency", config: { currencyCode: "USD", precision: 2 } })
    const r = validateFieldValue(d, { amount: "42.5", currency: "USD" })
    expect(r).toEqual({ ok: true, value: { amount: 42.5, currency: "USD" } })
  })

  it("requires iso date shape", () => {
    expect(validateFieldValue(def({ type: "date" }), "2024/01/01").ok).toBe(false)
    expect(validateFieldValue(def({ type: "date" }), "2024-01-01").ok).toBe(true)
  })

  it("coerces boolean-ish input", () => {
    expect(validateFieldValue(def({ type: "boolean" }), "yes")).toEqual({ ok: true, value: true })
    expect(validateFieldValue(def({ type: "boolean" }), "off")).toEqual({ ok: true, value: false })
  })

  it("restricts dropdown to defined options", () => {
    const d = def({ type: "dropdown", options: [{ value: "a", label: "A" }] })
    expect(validateFieldValue(d, "a").ok).toBe(true)
    expect(validateFieldValue(d, "z").ok).toBe(false)
  })

  it("dedupes and validates multiselect", () => {
    const d = def({
      type: "multiselect",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    })
    expect(validateFieldValue(d, ["a", "a", "b"])).toEqual({ ok: true, value: ["a", "b"] })
    expect(validateFieldValue(d, ["a", "z"]).ok).toBe(false)
  })

  it("requires positive integer ids for user/department relations", () => {
    expect(validateFieldValue(def({ type: "user" }), 0).ok).toBe(false)
    expect(validateFieldValue(def({ type: "user" }), 5)).toEqual({ ok: true, value: 5 })
  })

  it("wraps entity relation with its target", () => {
    const d = def({ type: "entity", config: { targetEntity: "account" } })
    expect(validateFieldValue(d, "acc_1")).toEqual({ ok: true, value: { entity: "account", id: "acc_1" } })
  })

  it("normalizes a file from a bare url string", () => {
    const r = validateFieldValue(def({ type: "file" }), "https://cdn.example.com/report.pdf")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toMatchObject({ name: "report.pdf", url: "https://cdn.example.com/report.pdf" })
  })

  it("never lets a formula value be set directly", () => {
    const r = validateFieldValue(def({ type: "formula", config: { formula: "1+1" } }), 5)
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Safe formula engine ("formula where safe")
// ---------------------------------------------------------------------------

describe("formula safety", () => {
  it("extracts lowercased references", () => {
    expect(extractFormulaRefs("Qty * Unit_Price + 2").sort()).toEqual(["qty", "unit_price"])
  })

  it("rejects anything outside the arithmetic grammar (injection-proof)", () => {
    for (const evil of [
      "process.exit(1)",
      "constructor",
      "a['b']",
      "fetch(1)",
      "1;2",
      "`x`",
    ]) {
      const check = checkFormula(evil, ["a", "b"])
      // Either disallowed characters or an unknown reference — never ok as-is.
      expect(check.ok).toBe(false)
    }
  })

  it("rejects references to unknown numeric fields", () => {
    const check = checkFormula("qty * mystery", ["qty"])
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.error).toMatch(/unknown numeric field/i)
  })

  it("rejects unbalanced parentheses", () => {
    expect(checkFormula("(qty * 2", ["qty"]).ok).toBe(false)
  })

  it("accepts a valid arithmetic expression", () => {
    const check = checkFormula("(qty * unit_price) - discount", ["qty", "unit_price", "discount"])
    expect(check.ok).toBe(true)
  })

  it("evaluates with operator precedence and parentheses", () => {
    expect(evaluateFormula("2 + 3 * 4", {})).toBe(14)
    expect(evaluateFormula("(2 + 3) * 4", {})).toBe(20)
    expect(evaluateFormula("qty * unit_price", { qty: 3, unit_price: 5 })).toBe(15)
  })

  it("treats unknown/non-numeric references as zero", () => {
    expect(evaluateFormula("qty + missing", { qty: 2 })).toBe(2)
  })

  it("returns null on division by zero rather than throwing or Infinity", () => {
    expect(evaluateFormula("1 / 0", {})).toBeNull()
  })

  it("returns undefined for malformed expressions", () => {
    expect(evaluateFormula("1 +", {})).toBeUndefined()
    expect(evaluateFormula("* 2", {})).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// numericValueOf — the operand a field contributes to a formula
// ---------------------------------------------------------------------------

describe("numericValueOf", () => {
  it("reads currency amount", () => {
    expect(numericValueOf(def({ type: "currency" }), { amount: 12.5, currency: "USD" })).toBe(12.5)
  })
  it("maps boolean to 1/0", () => {
    expect(numericValueOf(def({ type: "boolean" }), true)).toBe(1)
    expect(numericValueOf(def({ type: "boolean" }), false)).toBe(0)
  })
  it("is 0 for non-numeric types", () => {
    expect(numericValueOf(def({ type: "text" }), "abc")).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Permissions (fail-safe role ordering)
// ---------------------------------------------------------------------------

describe("field permissions", () => {
  it("view requires the role to meet viewMinRole", () => {
    const d = def({ viewMinRole: "tenant_admin" })
    expect(canViewField(d, "employee")).toBe(false)
    expect(canViewField(d, "tenant_admin")).toBe(true)
    expect(canViewField(d, "tenant_owner")).toBe(true)
  })

  it("edit requires both edit role and view clearance", () => {
    const d = def({ viewMinRole: "module_admin", editMinRole: "tenant_admin" })
    expect(canEditField(d, "module_admin")).toBe(false)
    expect(canEditField(d, "tenant_admin")).toBe(true)
  })

  it("formula fields are always read-only regardless of role", () => {
    const d = def({ type: "formula", editMinRole: "employee", config: { formula: "1" } })
    expect(canEditField(d, "tenant_owner")).toBe(false)
  })
})
