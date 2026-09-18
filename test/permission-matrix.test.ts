import { describe, it, expect } from "vitest"
import {
  ACTION_CATEGORIES,
  ACTION_CATEGORY_LABEL,
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  PERMISSION_SCOPES,
  baseActionCategory,
  classifyExtendedAction,
  defaultMatrix,
  emptyModulePermission,
  fullModulePermission,
  getExtendedAction,
  getModuleExtraActions,
  getPermissionModule,
  mergeMatrices,
  mergeModulePermission,
  mergeScope,
  resolveFeatureSlug,
  type ActionCategory,
  type ExtendedAction,
  type PermissionMatrix,
  type PermissionScope,
} from "@/lib/permission-model"

/**
 * SPEC 8 — Phase 4. The permission matrix is the enforcement contract for
 * enterprise RBAC: custom roles compose additively, per-user overrides layer on
 * top, and every module's bespoke high-risk verb must map onto ONE normalized
 * capability category (view/create/edit/delete, approve/reject, export, import,
 * download, email, configuration, administrative). These tests pin that pure
 * core so a change to scope-merging, role composition, the action taxonomy, or
 * feature-slug resolution can never silently widen or narrow access.
 *
 * The module under test has no DB / server-only imports, so the whole matrix is
 * exercised deterministically here.
 */

// ---------------------------------------------------------------------------
// Scope merge — the most-permissive lattice that role composition relies on.
// ---------------------------------------------------------------------------

describe("mergeScope — most-permissive scope lattice", () => {
  it("treats none as the identity element", () => {
    for (const s of PERMISSION_SCOPES) {
      expect(mergeScope("none", s)).toBe(s)
      expect(mergeScope(s, "none")).toBe(s)
    }
  })

  it("lets all dominate every other scope", () => {
    for (const s of PERMISSION_SCOPES) {
      expect(mergeScope("all", s)).toBe("all")
      expect(mergeScope(s, "all")).toBe("all")
    }
  })

  it("is idempotent for equal scopes", () => {
    for (const s of PERMISSION_SCOPES) {
      expect(mergeScope(s, s)).toBe(s)
    }
  })

  it("unions two different partial scopes into both", () => {
    expect(mergeScope("added", "owned")).toBe("both")
    expect(mergeScope("owned", "added")).toBe("both")
    expect(mergeScope("added", "both")).toBe("both")
    expect(mergeScope("owned", "both")).toBe("both")
  })

  it("is commutative across the whole lattice", () => {
    for (const a of PERMISSION_SCOPES) {
      for (const b of PERMISSION_SCOPES) {
        expect(mergeScope(a, b)).toBe(mergeScope(b, a))
      }
    }
  })

  it("never invents a scope outside the known set", () => {
    const valid = new Set<PermissionScope>(PERMISSION_SCOPES)
    for (const a of PERMISSION_SCOPES) {
      for (const b of PERMISSION_SCOPES) {
        expect(valid.has(mergeScope(a, b))).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Module permission merge — base CRUD + extended actions, most-permissive.
// ---------------------------------------------------------------------------

describe("mergeModulePermission", () => {
  it("merges each base action cell independently and most-permissively", () => {
    const a = { add: "added", view: "all", update: "none", delete: "none" } as const
    const b = { add: "owned", view: "none", update: "all", delete: "added" } as const
    expect(mergeModulePermission(a, b)).toEqual({
      add: "both", // added ∪ owned
      view: "all", // all dominates
      update: "all",
      delete: "added",
    })
  })

  it("omits the extra bag entirely when neither side has one", () => {
    const merged = mergeModulePermission(emptyModulePermission(), fullModulePermission())
    expect(merged.extra).toBeUndefined()
  })

  it("carries a one-sided extra bag through unchanged in value", () => {
    const withExtra = { ...emptyModulePermission(), extra: { file_return: "all" as PermissionScope } }
    const merged = mergeModulePermission(withExtra, emptyModulePermission())
    expect(merged.extra).toEqual({ file_return: "all" })
  })

  it("merges overlapping extended actions most-permissively", () => {
    const a = { ...emptyModulePermission(), extra: { approve: "added" as PermissionScope, export: "none" as PermissionScope } }
    const b = { ...emptyModulePermission(), extra: { approve: "owned" as PermissionScope, email: "all" as PermissionScope } }
    const merged = mergeModulePermission(a, b)
    expect(merged.extra).toEqual({ approve: "both", export: "none", email: "all" })
  })

  it("does not mutate its inputs", () => {
    const a = { ...emptyModulePermission(), extra: { approve: "added" as PermissionScope } }
    const b = { ...emptyModulePermission(), extra: { approve: "owned" as PermissionScope } }
    const aSnapshot = JSON.parse(JSON.stringify(a))
    const bSnapshot = JSON.parse(JSON.stringify(b))
    mergeModulePermission(a, b)
    expect(a).toEqual(aSnapshot)
    expect(b).toEqual(bSnapshot)
  })
})

// ---------------------------------------------------------------------------
// Matrix merge — the heart of additive role composition (roles + override).
// ---------------------------------------------------------------------------

describe("mergeMatrices — additive role composition", () => {
  it("returns null when there is nothing to merge (preserves legacy fallback)", () => {
    expect(mergeMatrices([])).toBeNull()
    expect(mergeMatrices([null, undefined])).toBeNull()
  })

  it("returns an equivalent (but independent) matrix for a single input", () => {
    const only: PermissionMatrix = { "sales.leads": { add: "all", view: "all", update: "added", delete: "none" } }
    const merged = mergeMatrices([only])!
    expect(merged).toEqual(only)
    // Independent copy — mutating the result must not touch the source.
    merged["sales.leads"].add = "none"
    expect(only["sales.leads"].add).toBe("all")
  })

  it("skips null / undefined layers and merges the rest", () => {
    const roleA: PermissionMatrix = { "sales.leads": { add: "added", view: "added", update: "none", delete: "none" } }
    const roleB: PermissionMatrix = { "sales.leads": { add: "owned", view: "all", update: "all", delete: "none" } }
    const merged = mergeMatrices([null, roleA, undefined, roleB])!
    expect(merged["sales.leads"]).toEqual({ add: "both", view: "all", update: "all", delete: "none" })
  })

  it("unions modules that appear in only some layers", () => {
    const roleA: PermissionMatrix = { "sales.leads": { add: "all", view: "all", update: "all", delete: "all" } }
    const roleB: PermissionMatrix = { "hr.employees": { add: "none", view: "all", update: "none", delete: "none" } }
    const merged = mergeMatrices([roleA, roleB])!
    expect(Object.keys(merged).sort()).toEqual(["hr.employees", "sales.leads"])
    expect(merged["sales.leads"].delete).toBe("all")
    expect(merged["hr.employees"].view).toBe("all")
  })

  it("layers a per-user override on top of roles most-permissively", () => {
    const rolesMatrix: PermissionMatrix = {
      "finance.gst_filing": { add: "added", view: "added", update: "none", delete: "none", extra: { file_return: "none" } },
    }
    const personalOverride: PermissionMatrix = {
      "finance.gst_filing": { add: "none", view: "all", update: "none", delete: "none", extra: { file_return: "all" } },
    }
    // permission-store merges as [rolesMatrix, personal]; the override can only widen.
    const merged = mergeMatrices([rolesMatrix, personalOverride])!
    expect(merged["finance.gst_filing"]).toEqual({
      add: "added",
      view: "all",
      update: "none",
      delete: "none",
      extra: { file_return: "all" },
    })
  })

  it("is order-independent for the resulting scopes (union is commutative)", () => {
    const roleA: PermissionMatrix = { "sales.leads": { add: "added", view: "none", update: "all", delete: "none" } }
    const roleB: PermissionMatrix = { "sales.leads": { add: "owned", view: "all", update: "none", delete: "added" } }
    expect(mergeMatrices([roleA, roleB])).toEqual(mergeMatrices([roleB, roleA]))
  })
})

// ---------------------------------------------------------------------------
// Normalized action taxonomy — every capability maps to exactly one category.
// ---------------------------------------------------------------------------

describe("normalized action taxonomy", () => {
  it("maps the four base CRUD actions onto view/create/edit/delete", () => {
    expect(baseActionCategory("add")).toBe("create")
    expect(baseActionCategory("update")).toBe("edit")
    expect(baseActionCategory("view")).toBe("view")
    expect(baseActionCategory("delete")).toBe("delete")
  })

  it("classifies representative verbs into the expected category", () => {
    const cases: Array<[string, string, ActionCategory]> = [
      ["approve_return", "Approve Return", "approve"],
      ["reject_offer", "Reject Offer", "reject"],
      ["revoke_offer", "Revoke Offer", "reject"],
      ["cancel_filing", "Cancel Filing", "reject"],
      ["export_journals", "Export Journals", "export"],
      ["import_export", "Import / Export", "import"], // import wins over export
      ["download_report", "Download Report", "download"],
      ["email_report", "Email Report", "email"],
      ["send_mail", "Send Mail", "email"],
      ["manage_settings", "Manage Settings", "configuration"],
      ["retention_rule", "Retention Rule", "configuration"],
      ["run_recalc", "Run Recalculation", "administrative"],
    ]
    for (const [key, label, expected] of cases) {
      expect(classifyExtendedAction({ key, label })).toBe(expected)
    }
  })

  it("classifies EVERY declared extended action into a known category", () => {
    const known = new Set<ActionCategory>(ACTION_CATEGORIES)
    for (const mod of PERMISSION_MODULES) {
      for (const ext of mod.extraActions ?? []) {
        const category = classifyExtendedAction(ext)
        expect(known.has(category), `${mod.key}.${ext.key} → ${category}`).toBe(true)
      }
    }
  })

  it("gives every category a human-readable label", () => {
    for (const c of ACTION_CATEGORIES) {
      expect(ACTION_CATEGORY_LABEL[c]).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// Matrix builders.
// ---------------------------------------------------------------------------

describe("matrix builders", () => {
  it("emptyModulePermission is all-none; fullModulePermission is all-all", () => {
    expect(emptyModulePermission()).toEqual({ add: "none", view: "none", update: "none", delete: "none" })
    expect(fullModulePermission()).toEqual({ add: "all", view: "all", update: "all", delete: "all" })
  })

  it("defaultMatrix covers every module with the requested scope", () => {
    const none = defaultMatrix("none")
    expect(Object.keys(none).length).toBe(PERMISSION_MODULES.length)
    for (const mod of PERMISSION_MODULES) {
      expect(none[mod.key]).toEqual({ add: "none", view: "none", update: "none", delete: "none" })
    }
    const all = defaultMatrix("all")
    for (const mod of PERMISSION_MODULES) {
      for (const action of PERMISSION_ACTIONS) {
        expect(all[mod.key][action]).toBe("all")
      }
    }
  })

  it("hands out independent cell objects per module (no shared reference)", () => {
    const m = defaultMatrix("none")
    const [first, second] = PERMISSION_MODULES
    if (first && second) {
      m[first.key].add = "all"
      expect(m[second.key].add).toBe("none")
    }
  })
})

// ---------------------------------------------------------------------------
// Module catalog integrity — the matrix keys the whole system trusts.
// ---------------------------------------------------------------------------

describe("module catalog integrity", () => {
  it("has globally unique module keys", () => {
    const keys = PERMISSION_MODULES.map((m) => m.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("resolves a module by key and exposes its extended actions", () => {
    for (const mod of PERMISSION_MODULES) {
      expect(getPermissionModule(mod.key)).toBe(mod)
      const extras = getModuleExtraActions(mod.key)
      expect(extras).toEqual(mod.extraActions ?? [])
      for (const ext of extras) {
        expect(getExtendedAction(mod.key, ext.key)).toBe(ext)
      }
    }
  })

  it("keeps extended-action keys unique within each module", () => {
    for (const mod of PERMISSION_MODULES) {
      const extraKeys = (mod.extraActions ?? []).map((e: ExtendedAction) => e.key)
      expect(new Set(extraKeys).size, mod.key).toBe(extraKeys.length)
    }
  })

  it("returns undefined for unknown module/action lookups", () => {
    expect(getPermissionModule("does.not.exist")).toBeUndefined()
    expect(getExtendedAction("does.not.exist", "nope")).toBeUndefined()
    expect(getModuleExtraActions("does.not.exist")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Feature-slug resolution — legacy nav/page gating driven from the matrix.
// ---------------------------------------------------------------------------

describe("resolveFeatureSlug", () => {
  it("returns null for malformed slugs", () => {
    expect(resolveFeatureSlug("")).toBeNull()
    expect(resolveFeatureSlug("noseparator")).toBeNull()
    expect(resolveFeatureSlug("unknowngroup.view_things")).toBeNull()
  })

  it("treats read/navigation slugs as a view action", () => {
    const r = resolveFeatureSlug("finance.gst_filing")
    expect(r?.action).toBe("view")
  })

  it("treats explicit write verbs as an update action", () => {
    for (const slug of ["sales.manage_leads", "hr.create_employee", "finance.delete_expense", "operations.approve_task"]) {
      expect(resolveFeatureSlug(slug)?.action).toBe("update")
    }
  })

  it("maps a slug onto a module within the correct group", () => {
    const r = resolveFeatureSlug("sales.view_leads")
    expect(r).not.toBeNull()
    const mod = getPermissionModule(r!.moduleKey)
    expect(mod?.group).toBe("sales")
  })

  it("resolves specific sub-module slugs to their own row, not a broader sibling", () => {
    // gst_filing must land on finance.gst_filing, not some generic finance row.
    expect(resolveFeatureSlug("finance.gst_filing")?.moduleKey).toBe("finance.gst_filing")
    expect(resolveFeatureSlug("finance.tds_filing")?.moduleKey).toBe("finance.tds_filing")
  })
})
