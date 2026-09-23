import { describe, it, expect } from "vitest"
import {
  baseCategoryGranted,
  evaluateConflicts,
  hasBlockingViolation,
  peakSeverity,
  type ResolvedConflict,
} from "@/lib/sod-core"
import {
  SOD_CONFLICTS,
  SOD_DUTIES,
  SOD_ENFORCEMENTS,
  SOD_SEVERITIES,
  getBuiltinConflict,
  getDuty,
} from "@/lib/sod-registry"
import type { ModulePermission } from "@/lib/permission-model"

/**
 * Phase 4. DB-free proof of the segregation-of-duties policy engine:
 * a single user must never hold both sides of an incompatible duty pair, a
 * disabled conflict must never fire, and only "block" enforcement stops an
 * assignment. Plus conflict-matrix / duty-catalog integrity for the four
 * maker-cannot-be-checker pairs the spec enumerates.
 */

// -----------------------------------------------------------------------------
// Conflict matrix + duty catalog integrity
// -----------------------------------------------------------------------------

describe("registry — duty catalog", () => {
  it("has unique duty keys", () => {
    const keys = SOD_DUTIES.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("pairs every domain with a create side and an approve side", () => {
    const byDomain = new Map<string, Set<string>>()
    for (const d of SOD_DUTIES) {
      if (!byDomain.has(d.domain)) byDomain.set(d.domain, new Set())
      byDomain.get(d.domain)!.add(d.side)
    }
    for (const [, sides] of byDomain) {
      expect(sides.has("create")).toBe(true)
      expect(sides.has("approve")).toBe(true)
    }
  })

  it("resolves create duties from a permission signal and approve duties from an approval signal", () => {
    for (const d of SOD_DUTIES) {
      if (d.side === "create") expect(d.signal.type).toBe("permission")
      else expect(d.signal.type).toBe("approval")
    }
  })

  it("looks duties up by key", () => {
    expect(getDuty("vendor.create")?.label).toBe("Create vendor")
    expect(getDuty("does.not.exist")).toBeUndefined()
  })
})

describe("registry — conflict matrix", () => {
  it("enumerates the four maker-cannot-be-checker pairs from the spec", () => {
    const keys = SOD_CONFLICTS.map((c) => c.key)
    expect(keys).toEqual([
      "vendor.create-vs-approve",
      "payment.create-vs-approve",
      "employee.create-vs-payroll.approve",
      "journal.create-vs-approve",
    ])
  })

  it("references two real, distinct duties per conflict", () => {
    for (const c of SOD_CONFLICTS) {
      expect(c.dutyA).not.toBe(c.dutyB)
      expect(getDuty(c.dutyA), `${c.key} dutyA`).toBeDefined()
      expect(getDuty(c.dutyB), `${c.key} dutyB`).toBeDefined()
    }
  })

  it("pairs a create-side duty with an approve-side duty", () => {
    for (const c of SOD_CONFLICTS) {
      const sides = [getDuty(c.dutyA)!.side, getDuty(c.dutyB)!.side].sort()
      expect(sides).toEqual(["approve", "create"])
    }
  })

  it("defaults every built-in conflict to enabled + block with a valid severity", () => {
    for (const c of SOD_CONFLICTS) {
      expect(c.defaultEnabled).toBe(true)
      expect(c.defaultEnforcement).toBe("block")
      expect(SOD_SEVERITIES).toContain(c.severity)
      expect(SOD_ENFORCEMENTS).toContain(c.defaultEnforcement)
    }
  })

  it("looks conflicts up by key", () => {
    expect(getBuiltinConflict("payment.create-vs-approve")?.severity).toBe("critical")
    expect(getBuiltinConflict("nope")).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// baseCategoryGranted — a permission grants a category only via a non-"none" scope
// -----------------------------------------------------------------------------

function perm(overrides: Partial<ModulePermission> = {}): ModulePermission {
  return { add: "none", view: "none", update: "none", delete: "none", ...overrides }
}

describe("baseCategoryGranted", () => {
  it("returns false for a null / missing permission", () => {
    expect(baseCategoryGranted(null, "create")).toBe(false)
    expect(baseCategoryGranted(undefined, "create")).toBe(false)
  })

  it("maps categories onto their base CRUD verb", () => {
    expect(baseCategoryGranted(perm({ add: "all" }), "create")).toBe(true)
    expect(baseCategoryGranted(perm({ update: "owned" }), "edit")).toBe(true)
    expect(baseCategoryGranted(perm({ view: "added" }), "view")).toBe(true)
    expect(baseCategoryGranted(perm({ delete: "both" }), "delete")).toBe(true)
  })

  it("treats a 'none' scope as not granted", () => {
    expect(baseCategoryGranted(perm({ add: "none" }), "create")).toBe(false)
  })

  it("returns false for categories without a base CRUD column (e.g. approve)", () => {
    expect(baseCategoryGranted(perm({ add: "all", update: "all" }), "approve" as never)).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// evaluateConflicts — the core policy decision
// -----------------------------------------------------------------------------

function conflict(overrides: Partial<ResolvedConflict> = {}): ResolvedConflict {
  return {
    key: "payment.create-vs-approve",
    label: "Create payment + approve payment",
    description: "",
    dutyA: "payment.create",
    dutyB: "payment.approve",
    severity: "critical",
    enforcement: "block",
    enabled: true,
    custom: false,
    ...overrides,
  }
}

describe("evaluateConflicts", () => {
  it("flags a violation only when BOTH duties are held", () => {
    const c = [conflict()]
    expect(evaluateConflicts(new Set(["payment.create", "payment.approve"]), c)).toHaveLength(1)
    expect(evaluateConflicts(new Set(["payment.create"]), c)).toHaveLength(0)
    expect(evaluateConflicts(new Set(["payment.approve"]), c)).toHaveLength(0)
    expect(evaluateConflicts(new Set(), c)).toHaveLength(0)
  })

  it("never fires a disabled conflict, even when both duties are held", () => {
    const c = [conflict({ enabled: false })]
    expect(evaluateConflicts(new Set(["payment.create", "payment.approve"]), c)).toHaveLength(0)
  })

  it("carries the conflict metadata onto the violation", () => {
    const [v] = evaluateConflicts(new Set(["payment.create", "payment.approve"]), [conflict()])
    expect(v).toMatchObject({
      conflictKey: "payment.create-vs-approve",
      dutyA: "payment.create",
      dutyB: "payment.approve",
      severity: "critical",
      enforcement: "block",
    })
  })

  it("detects independent violations across multiple conflicts", () => {
    const held = new Set(["payment.create", "payment.approve", "journal.create", "journal.approve"])
    const conflicts = [
      conflict(),
      conflict({
        key: "journal.create-vs-approve",
        dutyA: "journal.create",
        dutyB: "journal.approve",
        severity: "high",
      }),
    ]
    const violations = evaluateConflicts(held, conflicts)
    expect(violations.map((v) => v.conflictKey).sort()).toEqual([
      "journal.create-vs-approve",
      "payment.create-vs-approve",
    ])
  })
})

// -----------------------------------------------------------------------------
// hasBlockingViolation / peakSeverity — assignment gate + reporting helpers
// -----------------------------------------------------------------------------

describe("hasBlockingViolation", () => {
  it("blocks only when at least one violation is 'block' enforcement", () => {
    const held = new Set(["payment.create", "payment.approve"])
    expect(hasBlockingViolation(evaluateConflicts(held, [conflict({ enforcement: "block" })]))).toBe(true)
    expect(hasBlockingViolation(evaluateConflicts(held, [conflict({ enforcement: "warn" })]))).toBe(false)
    expect(hasBlockingViolation([])).toBe(false)
  })

  it("blocks when a warn and a block violation coexist", () => {
    const violations = [
      { conflictKey: "a", conflictLabel: "a", dutyA: "x", dutyB: "y", severity: "low" as const, enforcement: "warn" as const },
      { conflictKey: "b", conflictLabel: "b", dutyA: "p", dutyB: "q", severity: "high" as const, enforcement: "block" as const },
    ]
    expect(hasBlockingViolation(violations)).toBe(true)
  })
})

describe("peakSeverity", () => {
  it("returns null when there are no violations", () => {
    expect(peakSeverity([])).toBeNull()
  })

  it("returns the highest severity in ranked order", () => {
    const mk = (severity: "low" | "medium" | "high" | "critical") => ({
      conflictKey: severity,
      conflictLabel: severity,
      dutyA: "x",
      dutyB: "y",
      severity,
      enforcement: "warn" as const,
    })
    expect(peakSeverity([mk("low"), mk("high"), mk("medium")])).toBe("high")
    expect(peakSeverity([mk("low"), mk("critical")])).toBe("critical")
    expect(peakSeverity([mk("low")])).toBe("low")
  })
})
