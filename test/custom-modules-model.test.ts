import { describe, it, expect } from "vitest"
import {
  applyTransition,
  availableTransitions,
  canCreateRecord,
  canDeleteRecord,
  canEditRecord,
  canViewModule,
  initialState,
  isFinalState,
  normalizeAttachments,
  normalizeSlug,
  slugFromName,
  validateModuleDefinition,
  validateModuleField,
  validateRecordValues,
  type ModuleDefInput,
  type ModuleDefinition,
} from "@/lib/custom-modules/model"

/**
 * SPEC 96 — Phase 4. The custom-module engine turns tenant-authored metadata
 * (fields, list view, permissions, a workflow state machine, reports and
 * attachments) into storage, validation and a record CRUD + workflow API. All
 * of its safety lives in the pure model (no DB / server-only import), so these
 * tests pin every rule a regression could silently break — especially the
 * permission ordering and the workflow authority checks that stand between a
 * tenant's records and an unauthorized mutation.
 */

// ---------------------------------------------------------------------------
// Slug + name normalization
// ---------------------------------------------------------------------------

describe("normalizeSlug", () => {
  it("lowercases, hyphenates and trims", () => {
    expect(normalizeSlug("  Purchase Orders! ")).toBe("purchase-orders")
    expect(slugFromName("Field Visits")).toBe("field-visits")
  })

  it("never begins with a digit", () => {
    expect(normalizeSlug("2024 goals")).toBe("m-2024-goals")
  })

  it("caps length at 60 characters", () => {
    expect(normalizeSlug("a".repeat(200)).length).toBeLessThanOrEqual(60)
  })
})

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

describe("validateModuleField", () => {
  it("derives a key from the label when none is given", () => {
    const r = validateModuleField({ label: "Estimated Value", type: "number" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.field.key).toBe("estimated_value")
  })

  it("rejects a choice field with no options", () => {
    const r = validateModuleField({ label: "Stage", type: "dropdown", options: [] })
    expect(r.ok).toBe(false)
  })

  it("rejects a formula that references an unknown field", () => {
    const r = validateModuleField(
      { label: "Total", type: "formula", config: { formula: "qty * price" } },
      ["qty"], // price is not a sibling
    )
    expect(r.ok).toBe(false)
  })

  it("accepts a formula over known numeric siblings and forces it non-required", () => {
    const r = validateModuleField(
      { label: "Total", type: "formula", required: true, config: { formula: "qty * price" } },
      ["qty", "price"],
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.field.required).toBe(false) // computed fields are never required
      expect(r.field.config.formula).toBe("qty * price")
    }
  })

  it("rejects a self-referential formula", () => {
    const r = validateModuleField(
      { key: "total", label: "Total", type: "formula", config: { formula: "total + 1" } },
      ["total"],
    )
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Definition validation
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<ModuleDefInput> = {}): ModuleDefInput {
  return {
    name: "Purchase Order",
    fields: [
      { label: "Title", type: "text", showInList: true },
      { label: "Amount", type: "number", showInList: true },
    ],
    ...overrides,
  }
}

describe("validateModuleDefinition", () => {
  it("normalizes a minimal valid module", () => {
    const r = validateModuleDefinition(baseInput())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.def.slug).toBe("purchase-order")
      expect(r.def.pluralName).toBe("Purchase Orders")
      expect(r.def.status).toBe("draft")
      expect(r.def.fields.map((f) => f.key)).toEqual(["title", "amount"])
      // list view falls back to the fields flagged showInList
      expect(r.def.listView.columns).toEqual(["title", "amount"])
    }
  })

  it("requires at least one field", () => {
    const r = validateModuleDefinition(baseInput({ fields: [] }))
    expect(r.ok).toBe(false)
  })

  it("rejects duplicate field keys", () => {
    const r = validateModuleDefinition(
      baseInput({
        fields: [
          { key: "title", label: "Title", type: "text" },
          { key: "title", label: "Title Again", type: "text" },
        ],
      }),
    )
    expect(r.ok).toBe(false)
  })

  it("rejects reserved field keys", () => {
    const r = validateModuleDefinition(
      baseInput({ fields: [{ label: "State", type: "text" }] }),
    )
    expect(r.ok).toBe(false)
  })

  it("drops list-view columns that reference unknown fields", () => {
    const r = validateModuleDefinition(baseInput({ listView: { columns: ["title", "ghost"] } }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.def.listView.columns).toEqual(["title"])
  })

  it("validates report metrics against numeric fields", () => {
    const good = validateModuleDefinition(
      baseInput({
        reports: [{ label: "Totals", metrics: [{ op: "sum", field: "amount" }] }],
      }),
    )
    expect(good.ok).toBe(true)

    const bad = validateModuleDefinition(
      baseInput({
        reports: [{ label: "Totals", metrics: [{ op: "sum", field: "title" }] }],
      }),
    )
    expect(bad.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Permissions — ordering must be fail-safe
// ---------------------------------------------------------------------------

describe("module permissions", () => {
  it("rejects create access broader than view access", () => {
    const r = validateModuleDefinition(
      baseInput({ permissions: { viewMinRole: "tenant_admin", createMinRole: "employee" } }),
    )
    expect(r.ok).toBe(false)
  })

  it("gates each action by rank and never lets an unviewable role create/edit", () => {
    const perms = {
      viewMinRole: "employee" as const,
      createMinRole: "module_admin" as const,
      editMinRole: "module_admin" as const,
      deleteMinRole: "tenant_admin" as const,
    }
    expect(canViewModule(perms, "employee")).toBe(true)
    expect(canCreateRecord(perms, "employee")).toBe(false)
    expect(canCreateRecord(perms, "module_admin")).toBe(true)
    expect(canEditRecord(perms, "module_admin")).toBe(true)
    expect(canDeleteRecord(perms, "module_admin")).toBe(false)
    expect(canDeleteRecord(perms, "tenant_admin")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Workflow state machine
// ---------------------------------------------------------------------------

function withWorkflow(): ModuleDefinition {
  const r = validateModuleDefinition(
    baseInput({
      workflow: {
        enabled: true,
        states: [
          { key: "draft", label: "Draft", isInitial: true },
          { key: "approved", label: "Approved" },
          { key: "closed", label: "Closed", isFinal: true },
        ],
        transitions: [
          { from: "draft", to: "approved", minRole: "module_admin" },
          { from: "approved", to: "closed", minRole: "tenant_admin" },
        ],
      },
    }),
  )
  if (!r.ok) throw new Error("fixture module should be valid: " + r.errors.join(", "))
  return r.def
}

describe("workflow", () => {
  it("resolves the initial and final states", () => {
    const def = withWorkflow()
    expect(initialState(def.workflow)).toBe("draft")
    expect(isFinalState(def.workflow, "closed")).toBe(true)
    expect(isFinalState(def.workflow, "draft")).toBe(false)
  })

  it("only offers transitions the role is authorized for", () => {
    const wf = withWorkflow().workflow
    expect(availableTransitions(wf, "draft", "employee")).toHaveLength(0)
    expect(availableTransitions(wf, "draft", "module_admin").map((t) => t.to)).toEqual(["approved"])
  })

  it("re-derives authority server-side and refuses illegal jumps", () => {
    const wf = withWorkflow().workflow
    // Skipping a state is illegal even for an owner.
    expect(applyTransition(wf, "draft", "closed", "tenant_owner").ok).toBe(false)
    // Legal edge, but the role is too low.
    expect(applyTransition(wf, "approved", "closed", "module_admin").ok).toBe(false)
    // Legal edge with sufficient authority.
    const ok = applyTransition(wf, "approved", "closed", "tenant_admin")
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.to).toBe("closed")
  })

  it("rejects a workflow with fewer than two states", () => {
    const r = validateModuleDefinition(
      baseInput({ workflow: { enabled: true, states: [{ key: "only", label: "Only" }], transitions: [] } }),
    )
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Record value validation + formula derivation
// ---------------------------------------------------------------------------

describe("validateRecordValues", () => {
  function moduleWithFormula(): ModuleDefinition {
    const r = validateModuleDefinition({
      name: "Order Line",
      fields: [
        { key: "qty", label: "Qty", type: "number" },
        { key: "price", label: "Price", type: "number" },
        { key: "total", label: "Total", type: "formula", config: { formula: "qty * price" } },
      ],
    })
    if (!r.ok) throw new Error(r.errors.join(", "))
    return r.def
  }

  it("derives formula fields from validated numeric operands and ignores client-sent values", () => {
    const def = moduleWithFormula()
    const r = validateRecordValues(def, { qty: 3, price: 4, total: 999 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.values.total).toBe(12) // recomputed, not the client's 999
  })

  it("collects per-field errors and drops unknown keys", () => {
    const def = moduleWithFormula()
    const r = validateRecordValues(def, { qty: "not a number", ghost: "x" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors)).toContain("qty")
  })
})

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

describe("normalizeAttachments", () => {
  it("keeps only entries with a url and caps the count at 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ url: `https://x/${i}`, name: `f${i}` }))
    expect(normalizeAttachments(many)).toHaveLength(50)
    // Entries without a url are dropped; a missing name is derived from the url basename.
    expect(normalizeAttachments([{ name: "no url" }, { url: "https://host/file.pdf" }])).toEqual([
      { name: "file.pdf", url: "https://host/file.pdf", size: null },
    ])
  })

  it("returns an empty array for non-array input", () => {
    expect(normalizeAttachments(null)).toEqual([])
    expect(normalizeAttachments("nope")).toEqual([])
  })
})
