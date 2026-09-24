import { describe, it, expect } from "vitest"
import {
  GOV_STATUSES,
  GOV_ACTIONS,
  GOVERNED_KINDS,
  isGovernedKind,
  canTransition,
  allowedTransitions,
  resolvedStatusForAction,
  validateActionForStatus,
  evaluateApprovalAuthority,
  isEffectiveNow,
  statusLabel,
  type GovStatus,
} from "@/lib/master-data/governance-model"

/**
 * SPEC 91 — Phase 4. Governance only earns its keep if the pure rules that
 * drive the maker/checker workflow are deterministic and fail-safe. These pin
 * the state machine so a change can never silently: let an unreviewed edit skip
 * approval, allow an illegal lifecycle jump, or let a maker approve their own
 * request.
 */

describe("Phase 1 — governed masters", () => {
  it("governs only the critical, control-bearing masters", () => {
    expect([...GOVERNED_KINDS]).toEqual(["currencies", "payment_terms", "approval_levels", "cost_centers"])
  })

  it("recognizes governed vs freely-editable kinds", () => {
    expect(isGovernedKind("currencies")).toBe(true)
    expect(isGovernedKind("cost_centers")).toBe(true)
    // Non-critical reference lists stay ungoverned.
    expect(isGovernedKind("countries")).toBe(false)
    expect(isGovernedKind("cities")).toBe(false)
    expect(isGovernedKind("units")).toBe(false)
  })

  it("does not duplicate tax_codes (delegated to Finance's own approval)", () => {
    expect(isGovernedKind("tax_codes")).toBe(false)
  })
})

describe("Phase 2 — lifecycle transitions", () => {
  it("exposes the five standard lifecycle states", () => {
    expect([...GOV_STATUSES]).toEqual(["draft", "pending_approval", "active", "inactive", "archived"])
  })

  it("allows only legal forward/back transitions", () => {
    expect(canTransition("draft", "pending_approval")).toBe(true)
    expect(canTransition("pending_approval", "active")).toBe(true)
    expect(canTransition("active", "inactive")).toBe(true)
    expect(canTransition("inactive", "active")).toBe(true)
    expect(canTransition("active", "pending_approval")).toBe(true)
  })

  it("forbids illegal jumps and rejects any transition out of archived", () => {
    // Cannot skip approval straight to active.
    expect(canTransition("draft", "active")).toBe(false)
    // Cannot go from inactive directly to a new pending edit without... actually that IS allowed:
    expect(canTransition("inactive", "pending_approval")).toBe(true)
    // Archived is terminal.
    expect(allowedTransitions("archived")).toEqual([])
    for (const to of GOV_STATUSES) {
      expect(canTransition("archived", to)).toBe(false)
    }
  })

  it("every state can reach archived (except archived itself)", () => {
    for (const from of GOV_STATUSES) {
      if (from === "archived") continue
      expect(canTransition(from, "archived")).toBe(true)
    }
  })
})

describe("resolved status per action", () => {
  it("maps each approved action to its resting status", () => {
    expect(resolvedStatusForAction("create")).toBe("active")
    expect(resolvedStatusForAction("update")).toBe("active")
    expect(resolvedStatusForAction("reactivate")).toBe("active")
    expect(resolvedStatusForAction("deactivate")).toBe("inactive")
    expect(resolvedStatusForAction("archive")).toBe("archived")
  })

  it("covers every declared action", () => {
    for (const action of GOV_ACTIONS) {
      expect(GOV_STATUSES).toContain(resolvedStatusForAction(action))
    }
  })
})

describe("action ↔ status coherence", () => {
  it("create is valid only for a brand-new or draft value", () => {
    expect(validateActionForStatus("create", null).ok).toBe(true)
    expect(validateActionForStatus("create", "draft").ok).toBe(true)
    const active = validateActionForStatus("create", "active")
    expect(active.ok).toBe(false)
    if (!active.ok) expect(active.reason).toMatch(/already governed/i)
  })

  it("mutations require an existing governed value", () => {
    for (const action of ["update", "deactivate", "reactivate", "archive"] as const) {
      const res = validateActionForStatus(action, null)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toMatch(/not under governance/i)
    }
  })

  it("deactivate only from active, reactivate only from inactive", () => {
    expect(validateActionForStatus("deactivate", "active").ok).toBe(true)
    expect(validateActionForStatus("deactivate", "inactive").ok).toBe(false)
    expect(validateActionForStatus("reactivate", "inactive").ok).toBe(true)
    expect(validateActionForStatus("reactivate", "active").ok).toBe(false)
  })

  it("nothing can change once archived", () => {
    for (const action of GOV_ACTIONS) {
      if (action === "create") continue
      const res = validateActionForStatus(action, "archived")
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toMatch(/archived/i)
    }
  })
})

describe("approval authority — segregation of duties", () => {
  it("blocks the maker from approving their own request", () => {
    const res = evaluateApprovalAuthority({
      requesterId: 7,
      approverId: 7,
      approverIsAdmin: true,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/cannot approve/i)
  })

  it("lets a different tenant admin approve", () => {
    expect(
      evaluateApprovalAuthority({ requesterId: 7, approverId: 9, approverIsAdmin: true }).ok,
    ).toBe(true)
  })

  it("lets a non-admin approve only when they hold the required authority", () => {
    expect(
      evaluateApprovalAuthority({
        requesterId: 7,
        approverId: 9,
        approverIsAdmin: false,
        approverAuthorities: ["finance_controller"],
        requiredAuthority: "finance_controller",
      }).ok,
    ).toBe(true)

    const denied = evaluateApprovalAuthority({
      requesterId: 7,
      approverId: 9,
      approverIsAdmin: false,
      approverAuthorities: ["hr_head"],
      requiredAuthority: "finance_controller",
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toMatch(/authority/i)
  })

  it("denies a non-admin with no authority even when none is required", () => {
    expect(
      evaluateApprovalAuthority({
        requesterId: 7,
        approverId: 9,
        approverIsAdmin: false,
        approverAuthorities: [],
        requiredAuthority: null,
      }).ok,
    ).toBe(false)
  })
})

describe("effective dating", () => {
  const now = new Date("2026-06-15T09:00:00Z")

  it("treats a null/empty effective date as immediate", () => {
    expect(isEffectiveNow(null, now)).toBe(true)
    expect(isEffectiveNow(undefined, now)).toBe(true)
    expect(isEffectiveNow("", now)).toBe(true)
  })

  it("is effective for today and any past date", () => {
    expect(isEffectiveNow("2026-06-15", now)).toBe(true)
    expect(isEffectiveNow("2026-01-01", now)).toBe(true)
  })

  it("is not yet effective for a future date", () => {
    expect(isEffectiveNow("2026-06-16", now)).toBe(false)
    expect(isEffectiveNow("2027-01-01", now)).toBe(false)
  })
})

describe("status labels", () => {
  it("gives a human label for every status", () => {
    const labels: Record<GovStatus, string> = {
      draft: "Draft",
      pending_approval: "Pending Approval",
      active: "Active",
      inactive: "Inactive",
      archived: "Archived",
    }
    for (const status of GOV_STATUSES) {
      expect(statusLabel(status)).toBe(labels[status])
    }
  })
})
