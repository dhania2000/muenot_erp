import { describe, it, expect } from "vitest"
import {
  applyReview,
  canReview,
  evaluateCondition,
  evaluateConditionGroup,
  isFieldVisible,
  isSectionVisible,
  keyFromLabel,
  normalizeKey,
  normalizeSlug,
  statusOnSubmit,
  validateFieldValue,
  validateFormDefinition,
  validateSubmission,
  visibleFields,
  type Condition,
  type ConditionGroup,
  type FormApproval,
  type FormDefInput,
  type FormDefinition,
  type FormField,
  type FormSection,
} from "@/lib/custom-forms/model"

/**
 * SPEC 95 — Phase 4. The custom-form engine turns tenant-authored metadata into
 * rendering, conditional visibility, validation and an approval workflow. Its
 * safety rests entirely on the pure model (no DB / server-only imports), so
 * these tests pin every rule a regression could silently break:
 *
 *   - definition validation + referential integrity of conditional rules
 *   - the conditional-evaluation engine (operators, AND/OR, nesting)
 *   - per-value validation for every field type
 *   - conditional SUBMISSION validation (hidden fields are neither required
 *     nor stored — the client is never trusted)
 *   - the submission state machine and approver permissions
 */

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function field(overrides: Partial<FormField> = {}): FormField {
  return {
    key: "field",
    label: "Field",
    type: "text",
    required: false,
    helpText: "",
    options: [],
    config: {},
    defaultValue: null,
    visibility: null,
    ...overrides,
  }
}

function section(overrides: Partial<FormSection> = {}): FormSection {
  return {
    key: "section",
    title: "Section",
    description: "",
    visibility: null,
    fields: [field()],
    ...overrides,
  }
}

function form(overrides: Partial<FormDefinition> = {}): FormDefinition {
  return {
    id: 1,
    title: "Form",
    slug: "form",
    description: "",
    status: "published",
    submitLabel: "Submit",
    approval: { enabled: false, approverMinRole: "tenant_admin" },
    sections: [section()],
    version: 1,
    ...overrides,
  }
}

function group(rules: Condition[], match: "all" | "any" = "all"): ConditionGroup {
  return { match, rules }
}

// A realistic conditional definition input used across several suites: an
// "expense claim" whose "reason" field only appears when amount > 1000, inside
// a "manager approval" section shown only when a category dropdown is "travel".
function expenseInput(): FormDefInput {
  return {
    title: "Expense Claim",
    status: "published",
    approval: { enabled: true, approverMinRole: "tenant_admin" },
    sections: [
      {
        title: "Details",
        fields: [
          { label: "Amount", type: "number", required: true, config: { min: 0 } },
          { label: "Category", type: "dropdown", required: true, options: ["travel", "office", "food"] },
          {
            label: "Reason",
            type: "textarea",
            required: true,
            visibility: { match: "all", rules: [{ field: "amount", operator: "gt", value: "1000" }] },
          },
        ],
      },
      {
        title: "Manager Approval",
        visibility: { match: "all", rules: [{ field: "category", operator: "equals", value: "travel" }] },
        fields: [{ label: "Manager Email", type: "email", required: true }],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe("normalizeKey / keyFromLabel", () => {
  it("lowercases, collapses separators and trims underscores", () => {
    expect(normalizeKey("  Manager Email! ")).toBe("manager_email")
    expect(keyFromLabel("Total Cost ($)")).toBe("total_cost")
  })
  it("prefixes keys that would start with a digit", () => {
    expect(normalizeKey("2024 budget")).toBe("f_2024_budget")
  })
  it("returns empty string for input with no usable characters", () => {
    expect(normalizeKey("!!!")).toBe("")
  })
})

describe("normalizeSlug", () => {
  it("produces a url-safe hyphenated slug", () => {
    expect(normalizeSlug("New Vendor Onboarding!")).toBe("new-vendor-onboarding")
  })
  it("trims leading/trailing separators", () => {
    expect(normalizeSlug("  --Hello--  ")).toBe("hello")
  })
})

// ---------------------------------------------------------------------------
// Definition validation
// ---------------------------------------------------------------------------

describe("validateFormDefinition", () => {
  it("accepts a well-formed conditional form and derives keys + slug", () => {
    const result = validateFormDefinition(expenseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.def.slug).toBe("expense-claim")
    expect(result.def.sections).toHaveLength(2)
    expect(result.def.sections[0].fields.map((f) => f.key)).toEqual(["amount", "category", "reason"])
    // dropdown options are normalized into {value,label} pairs
    expect(result.def.sections[0].fields[1].options).toEqual([
      { value: "travel", label: "travel" },
      { value: "office", label: "office" },
      { value: "food", label: "food" },
    ])
  })

  it("requires a title", () => {
    const result = validateFormDefinition({ title: "  ", sections: [section()] as unknown as unknown[] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(" ")).toMatch(/title is required/i)
  })

  it("requires at least one section, and each section at least one field", () => {
    const noSections = validateFormDefinition({ title: "X", sections: [] })
    expect(noSections.ok).toBe(false)

    const emptySection = validateFormDefinition({
      title: "X",
      sections: [{ title: "Empty", fields: [] }],
    })
    expect(emptySection.ok).toBe(false)
    if (emptySection.ok) return
    expect(emptySection.errors.join(" ")).toMatch(/needs at least one field/i)
  })

  it("rejects duplicate field keys across the whole form", () => {
    const result = validateFormDefinition({
      title: "Dup",
      sections: [
        { title: "A", fields: [{ label: "Name", type: "text" }] },
        { title: "B", fields: [{ label: "Name", type: "text" }] },
      ],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(" ")).toMatch(/duplicate field key/i)
  })

  it("rejects an option-bearing field with no options", () => {
    const result = validateFormDefinition({
      title: "X",
      sections: [{ title: "A", fields: [{ label: "Pick", type: "dropdown", options: [] }] }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(" ")).toMatch(/needs at least one option/i)
  })

  it("rejects a number field whose min exceeds its max", () => {
    const result = validateFormDefinition({
      title: "X",
      sections: [{ title: "A", fields: [{ label: "N", type: "number", config: { min: 10, max: 1 } }] }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(" ")).toMatch(/minimum cannot be greater than maximum/i)
  })

  // Referential integrity of conditional logic — the core safety guarantee.
  it("rejects a condition that references a field that does not exist", () => {
    const result = validateFormDefinition({
      title: "X",
      sections: [
        {
          title: "A",
          fields: [
            {
              label: "Reason",
              type: "text",
              visibility: { match: "all", rules: [{ field: "ghost", operator: "equals", value: "y" }] },
            },
          ],
        },
      ],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(" ")).toMatch(/unknown field "ghost"/i)
  })

  it("rejects a field whose visibility depends on itself", () => {
    const result = validateFormDefinition({
      title: "X",
      sections: [
        {
          title: "A",
          fields: [
            {
              label: "Loop",
              type: "text",
              visibility: { match: "all", rules: [{ field: "loop", operator: "is_not_empty", value: "" }] },
            },
          ],
        },
      ],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(" ")).toMatch(/cannot depend on itself/i)
  })

  it("allows a condition to reference a field declared later in the form (forward reference)", () => {
    const result = validateFormDefinition({
      title: "X",
      sections: [
        {
          title: "A",
          fields: [
            {
              label: "Shown",
              type: "text",
              visibility: { match: "all", rules: [{ field: "toggle", operator: "equals", value: "yes" }] },
            },
            { label: "Toggle", type: "text" },
          ],
        },
      ],
    })
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Conditional evaluation engine
// ---------------------------------------------------------------------------

describe("evaluateCondition", () => {
  it("equals / not_equals compare as strings", () => {
    expect(evaluateCondition({ field: "a", operator: "equals", value: "x" }, { a: "x" })).toBe(true)
    expect(evaluateCondition({ field: "a", operator: "not_equals", value: "x" }, { a: "y" })).toBe(true)
  })

  it("equals matches a boolean value against its string form", () => {
    expect(evaluateCondition({ field: "a", operator: "equals", value: "true" }, { a: true })).toBe(true)
    expect(evaluateCondition({ field: "a", operator: "equals", value: "false" }, { a: true })).toBe(false)
  })

  it("equals against an array matches when any member equals the target", () => {
    expect(evaluateCondition({ field: "a", operator: "equals", value: "b" }, { a: ["a", "b"] })).toBe(true)
  })

  it("contains / not_contains work on strings and arrays", () => {
    expect(evaluateCondition({ field: "a", operator: "contains", value: "ell" }, { a: "hello" })).toBe(true)
    expect(evaluateCondition({ field: "a", operator: "contains", value: "x" }, { a: ["y", "xz"] })).toBe(true)
    expect(evaluateCondition({ field: "a", operator: "not_contains", value: "q" }, { a: "hello" })).toBe(true)
  })

  it("numeric comparisons coerce and fail closed on non-numbers", () => {
    expect(evaluateCondition({ field: "a", operator: "gt", value: "1000" }, { a: 2000 })).toBe(true)
    expect(evaluateCondition({ field: "a", operator: "gte", value: "5" }, { a: 5 })).toBe(true)
    expect(evaluateCondition({ field: "a", operator: "lt", value: "5" }, { a: 10 })).toBe(false)
    expect(evaluateCondition({ field: "a", operator: "lte", value: "5" }, { a: "abc" })).toBe(false)
  })

  it("in matches any of a comma-separated set, case-insensitively", () => {
    expect(evaluateCondition({ field: "a", operator: "in", value: "red, green ,blue" }, { a: "GREEN" })).toBe(true)
    expect(evaluateCondition({ field: "a", operator: "in", value: "red,blue" }, { a: "green" })).toBe(false)
    expect(evaluateCondition({ field: "a", operator: "in", value: "x,y" }, { a: ["z", "y"] })).toBe(true)
  })

  it("is_empty / is_not_empty treat null, empty string and empty array as blank", () => {
    expect(evaluateCondition({ field: "a", operator: "is_empty", value: "" }, {})).toBe(true)
    expect(evaluateCondition({ field: "a", operator: "is_empty", value: "" }, { a: [] })).toBe(true)
    expect(evaluateCondition({ field: "a", operator: "is_not_empty", value: "" }, { a: "x" })).toBe(true)
  })
})

describe("evaluateConditionGroup", () => {
  it("an empty group always passes (unconditional)", () => {
    expect(evaluateConditionGroup(null, {})).toBe(true)
    expect(evaluateConditionGroup(group([]), {})).toBe(true)
  })

  it("match=all requires every rule (AND)", () => {
    const g = group([
      { field: "a", operator: "equals", value: "1" },
      { field: "b", operator: "equals", value: "2" },
    ])
    expect(evaluateConditionGroup(g, { a: "1", b: "2" })).toBe(true)
    expect(evaluateConditionGroup(g, { a: "1", b: "9" })).toBe(false)
  })

  it("match=any requires at least one rule (OR)", () => {
    const g = group(
      [
        { field: "a", operator: "equals", value: "1" },
        { field: "b", operator: "equals", value: "2" },
      ],
      "any",
    )
    expect(evaluateConditionGroup(g, { a: "1", b: "9" })).toBe(true)
    expect(evaluateConditionGroup(g, { a: "9", b: "9" })).toBe(false)
  })
})

describe("section & field visibility", () => {
  const sec = section({
    key: "approval",
    visibility: group([{ field: "category", operator: "equals", value: "travel" }]),
    fields: [
      field({ key: "manager", label: "Manager" }),
      field({
        key: "reason",
        label: "Reason",
        visibility: group([{ field: "amount", operator: "gt", value: "1000" }]),
      }),
    ],
  })

  it("a field in a hidden section is itself hidden even if its own condition passes", () => {
    // section hidden (category != travel), but reason's own condition passes
    const values = { category: "office", amount: 5000 }
    expect(isSectionVisible(sec, values)).toBe(false)
    expect(isFieldVisible(sec, sec.fields[1], values)).toBe(false)
  })

  it("a field shows only when BOTH its section and its own condition pass", () => {
    expect(isFieldVisible(sec, sec.fields[1], { category: "travel", amount: 5000 })).toBe(true)
    expect(isFieldVisible(sec, sec.fields[1], { category: "travel", amount: 10 })).toBe(false)
  })

  it("visibleFields flattens only the currently-visible fields", () => {
    const f = form({ sections: [sec] })
    const visible = visibleFields(f, { category: "travel", amount: 5000 }).map((x) => x.key)
    expect(visible).toEqual(["manager", "reason"])
    const collapsed = visibleFields(f, { category: "office", amount: 5000 }).map((x) => x.key)
    expect(collapsed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Per-value validation
// ---------------------------------------------------------------------------

describe("validateFieldValue", () => {
  it("enforces required only against a blank value", () => {
    expect(validateFieldValue(field({ required: true }), "")).toMatchObject({ ok: false })
    expect(validateFieldValue(field({ required: false }), "")).toMatchObject({ ok: true, value: null })
  })

  it("validates email, url and phone shapes", () => {
    expect(validateFieldValue(field({ type: "email" }), "a@b.com")).toMatchObject({ ok: true })
    expect(validateFieldValue(field({ type: "email" }), "nope")).toMatchObject({ ok: false })
    expect(validateFieldValue(field({ type: "url" }), "https://x.com")).toMatchObject({ ok: true })
    expect(validateFieldValue(field({ type: "url" }), "javascript:alert(1)")).toMatchObject({ ok: false })
    expect(validateFieldValue(field({ type: "phone" }), "+1 (555) 123-4567")).toMatchObject({ ok: true })
    expect(validateFieldValue(field({ type: "phone" }), "abc")).toMatchObject({ ok: false })
  })

  it("enforces numeric range", () => {
    const f = field({ type: "number", config: { min: 0, max: 100 } })
    expect(validateFieldValue(f, 50)).toMatchObject({ ok: true, value: 50 })
    expect(validateFieldValue(f, -1)).toMatchObject({ ok: false })
    expect(validateFieldValue(f, 101)).toMatchObject({ ok: false })
    expect(validateFieldValue(f, "not-a-number")).toMatchObject({ ok: false })
  })

  it("requires ISO dates", () => {
    expect(validateFieldValue(field({ type: "date" }), "2026-02-14")).toMatchObject({ ok: true })
    expect(validateFieldValue(field({ type: "date" }), "14/02/2026")).toMatchObject({ ok: false })
  })

  it("coerces boolean truthy/falsey strings", () => {
    expect(validateFieldValue(field({ type: "boolean" }), "yes")).toMatchObject({ ok: true, value: true })
    expect(validateFieldValue(field({ type: "boolean" }), "off")).toMatchObject({ ok: true, value: false })
    expect(validateFieldValue(field({ type: "boolean" }), "maybe")).toMatchObject({ ok: false })
  })

  it("dropdown rejects values outside its option list", () => {
    const f = field({ type: "dropdown", options: [{ value: "a", label: "A" }] })
    expect(validateFieldValue(f, "a")).toMatchObject({ ok: true })
    expect(validateFieldValue(f, "z")).toMatchObject({ ok: false })
  })

  it("multiselect validates every member and de-duplicates", () => {
    const f = field({
      type: "multiselect",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    })
    expect(validateFieldValue(f, ["a", "b", "a"])).toMatchObject({ ok: true, value: ["a", "b"] })
    expect(validateFieldValue(f, ["a", "z"])).toMatchObject({ ok: false })
  })

  it("file normalizes a string url and an object into {name,url}", () => {
    expect(validateFieldValue(field({ type: "file" }), "https://cdn/x/report.pdf")).toMatchObject({
      ok: true,
      value: { name: "report.pdf", url: "https://cdn/x/report.pdf" },
    })
    expect(validateFieldValue(field({ type: "file" }), { url: "https://cdn/y.png", name: "y.png", size: 10 })).toMatchObject({
      ok: true,
      value: { name: "y.png", url: "https://cdn/y.png", size: 10 },
    })
  })
})

// ---------------------------------------------------------------------------
// Conditional submission validation (the client is never trusted)
// ---------------------------------------------------------------------------

describe("validateSubmission", () => {
  const built = validateFormDefinition(expenseInput())
  const expense = built.ok ? built.def : form()

  it("does not require a hidden required field, and drops its value", () => {
    // amount <= 1000 hides Reason; category != travel hides the whole approval section.
    const result = validateSubmission(expense, {
      amount: 500,
      category: "office",
      reason: "should be discarded",
      manager_email: "leaked@x.com",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.values).toEqual({ amount: 500, category: "office" })
    expect(result.values).not.toHaveProperty("reason")
    expect(result.values).not.toHaveProperty("manager_email")
  })

  it("requires a conditionally-shown field once its condition is met", () => {
    const result = validateSubmission(expense, { amount: 5000, category: "office" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveProperty("reason")
  })

  it("validates fields inside a conditionally-shown section", () => {
    const missing = validateSubmission(expense, { amount: 500, category: "travel" })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.errors).toHaveProperty("manager_email")

    const ok = validateSubmission(expense, { amount: 500, category: "travel", manager_email: "m@x.com" })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.values).toEqual({ amount: 500, category: "travel", manager_email: "m@x.com" })
  })

  it("reports a type error for a visible field", () => {
    const result = validateSubmission(expense, { amount: "not-a-number", category: "office" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveProperty("amount")
  })
})

// ---------------------------------------------------------------------------
// Submission workflow + approver permissions
// ---------------------------------------------------------------------------

describe("submission workflow", () => {
  const approval: FormApproval = { enabled: true, approverMinRole: "tenant_admin" }
  const noApproval: FormApproval = { enabled: false, approverMinRole: "tenant_admin" }

  it("lands in pending when approval is required, submitted otherwise", () => {
    expect(statusOnSubmit(true)).toBe("pending")
    expect(statusOnSubmit(false)).toBe("submitted")
  })

  it("an approver at/above the min role may approve or reject a pending submission", () => {
    expect(applyReview("pending", "approve", approval, "tenant_admin")).toEqual({ ok: true, status: "approved" })
    expect(applyReview("pending", "reject", approval, "tenant_owner")).toEqual({ ok: true, status: "rejected" })
  })

  it("a role below the min role cannot review", () => {
    const result = applyReview("pending", "approve", approval, "module_admin")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/permission/i)
  })

  it("only a pending submission can be reviewed", () => {
    expect(applyReview("approved", "approve", approval, "tenant_owner").ok).toBe(false)
    expect(applyReview("submitted", "reject", approval, "tenant_owner").ok).toBe(false)
    expect(applyReview("draft", "approve", approval, "tenant_owner").ok).toBe(false)
  })

  it("a form without approval cannot be reviewed at all", () => {
    const result = applyReview("pending", "approve", noApproval, "tenant_owner")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/does not require approval/i)
  })

  it("canReview mirrors applyReview's authority check", () => {
    expect(canReview(approval, "tenant_admin")).toBe(true)
    expect(canReview(approval, "employee")).toBe(false)
    expect(canReview(noApproval, "tenant_owner")).toBe(false)
  })
})
