import { describe, it, expect } from "vitest"
import {
  CLASSIFICATION_LEVELS,
  DEFAULT_CLEARANCE_MATRIX,
  canAccessClassification,
  canAutoDeleteAtLevel,
  canExportClassification,
  levelAtLeast,
  maxLevel,
  normalizeClearanceMatrix,
  recordClassification,
  redactedExportFields,
  toClassificationLevel,
  type ClassifiedField,
} from "@/lib/data-classification-model"

/**
 * Phase 4. Classification only earns its keep if the enforcement
 * decisions it drives (access, export, retention) are deterministic and
 * fail-safe. These pin the pure model so a change can never silently let an
 * under-cleared role read/export sensitive data or auto-delete protected records.
 */

describe("level ordering", () => {
  it("orders the five standard levels least → most sensitive", () => {
    expect(CLASSIFICATION_LEVELS).toEqual([
      "Public",
      "Internal",
      "Confidential",
      "Restricted",
      "Highly Restricted",
    ])
  })

  it("levelAtLeast compares by sensitivity rank", () => {
    expect(levelAtLeast("Restricted", "Confidential")).toBe(true)
    expect(levelAtLeast("Internal", "Restricted")).toBe(false)
    expect(levelAtLeast("Public", "Public")).toBe(true)
  })

  it("maxLevel returns the more sensitive of two", () => {
    expect(maxLevel("Public", "Restricted")).toBe("Restricted")
    expect(maxLevel("Highly Restricted", "Confidential")).toBe("Highly Restricted")
  })

  it("recordClassification rolls fields up to the highest level present", () => {
    expect(
      recordClassification([{ level: "Public" }, { level: "Confidential" }, { level: "Internal" }]),
    ).toBe("Confidential")
    expect(recordClassification([])).toBeNull()
  })

  it("toClassificationLevel defaults unknown input to Internal", () => {
    expect(toClassificationLevel("bogus")).toBe("Internal")
    expect(toClassificationLevel("Restricted")).toBe("Restricted")
  })
})

describe("access enforcement (default matrix)", () => {
  it("lets an employee read Public/Internal but not Confidential+", () => {
    expect(canAccessClassification("Internal", "employee")).toBe(true)
    expect(canAccessClassification("Confidential", "employee")).toBe(false)
    expect(canAccessClassification("Restricted", "employee")).toBe(false)
  })

  it("lets a module_admin read up to Confidential, tenant_admin up to Restricted", () => {
    expect(canAccessClassification("Confidential", "module_admin")).toBe(true)
    expect(canAccessClassification("Restricted", "module_admin")).toBe(false)
    expect(canAccessClassification("Restricted", "tenant_admin")).toBe(true)
    expect(canAccessClassification("Highly Restricted", "tenant_admin")).toBe(false)
  })

  it("reserves Highly Restricted for the tenant_owner", () => {
    expect(canAccessClassification("Highly Restricted", "tenant_owner")).toBe(true)
    expect(canAccessClassification("Highly Restricted", "tenant_admin")).toBe(false)
  })
})

describe("export enforcement", () => {
  const fields: ClassifiedField[] = [
    { field: "name", level: "Public" },
    { field: "email", level: "Internal" },
    { field: "salary", level: "Restricted" },
    { field: "bank_account", level: "Highly Restricted" },
    { field: "notes", level: "Restricted", enforceExport: false }, // export not enforced
  ]

  it("redacts fields the role cannot export, honoring per-field enforcement", () => {
    const redacted = redactedExportFields(fields, "employee")
    expect(redacted.has("salary")).toBe(true)
    expect(redacted.has("bank_account")).toBe(true)
    // Public/Internal are exportable by everyone.
    expect(redacted.has("name")).toBe(false)
    expect(redacted.has("email")).toBe(false)
    // enforceExport:false always passes through even when over the bar.
    expect(redacted.has("notes")).toBe(false)
  })

  it("owner can export everything", () => {
    expect(redactedExportFields(fields, "tenant_owner").size).toBe(0)
  })

  it("canExportClassification uses the export bar independently of access", () => {
    expect(canExportClassification("Restricted", "tenant_admin")).toBe(true)
    expect(canExportClassification("Restricted", "module_admin")).toBe(false)
  })
})

describe("retention enforcement", () => {
  it("forbids auto-delete for Restricted / Highly Restricted by default", () => {
    expect(canAutoDeleteAtLevel("Public")).toBe(true)
    expect(canAutoDeleteAtLevel("Confidential")).toBe(true)
    expect(canAutoDeleteAtLevel("Restricted")).toBe(false)
    expect(canAutoDeleteAtLevel("Highly Restricted")).toBe(false)
  })
})

describe("clearance matrix normalization", () => {
  it("fills a complete matrix from partial/malformed input without widening defaults", () => {
    const m = normalizeClearanceMatrix({ Confidential: { accessMinRole: "tenant_admin" } })
    expect(m.Confidential.accessMinRole).toBe("tenant_admin")
    // missing fields fall back to defaults
    expect(m.Confidential.exportMinRole).toBe(DEFAULT_CLEARANCE_MATRIX.Confidential.exportMinRole)
    // untouched levels keep defaults
    expect(m.Restricted).toEqual(DEFAULT_CLEARANCE_MATRIX.Restricted)
    // every level present
    for (const level of CLASSIFICATION_LEVELS) expect(m[level]).toBeDefined()
  })

  it("coerces an invalid role to employee (never a higher role)", () => {
    const m = normalizeClearanceMatrix({ Public: { accessMinRole: "superuser" } })
    expect(m.Public.accessMinRole).toBe("employee")
  })

  it("a custom matrix changes the export decision", () => {
    const strict = normalizeClearanceMatrix({
      Internal: { accessMinRole: "tenant_admin", exportMinRole: "tenant_admin", allowAutoDelete: false },
    })
    expect(canExportClassification("Internal", "employee", strict)).toBe(false)
    expect(canExportClassification("Internal", "tenant_admin", strict)).toBe(true)
  })
})
