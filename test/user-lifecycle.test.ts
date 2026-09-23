import { describe, it, expect } from "vitest"
import {
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  canTransition,
  evaluateLogin,
  isLifecycleState,
  statusForLifecycle,
  targetStateForAction,
  validateAction,
  type LifecycleState,
  type UserLifecycleSnapshot,
} from "@/lib/user-lifecycle-core"

/**
 * Phase 4. DB-free proof of the user-lifecycle state model against
 * the three canonical identity-governance scenarios:
 *
 *   Joiner  — invitation → acceptance/activation → verification → able to log in.
 *   Mover   — role/department changes and suspension/reactivation without ever
 *             leaving the graph of allowed transitions.
 *   Leaver  — deactivation (offboarding) is terminal for sign-in, reachable
 *             from every live state, and only reversible by an explicit rehire.
 *
 * Plus the login gate (`evaluateLogin`) that every one of those states funnels
 * through, and the transition-graph integrity the DB layer relies on.
 */

// -----------------------------------------------------------------------------
// Transition-graph integrity
// -----------------------------------------------------------------------------

describe("transition graph", () => {
  it("declares transitions for every lifecycle state", () => {
    for (const state of LIFECYCLE_STATES) {
      expect(LIFECYCLE_TRANSITIONS[state]).toBeDefined()
    }
  })

  it("never lists a self-transition and only points at real states", () => {
    for (const from of LIFECYCLE_STATES) {
      for (const to of LIFECYCLE_TRANSITIONS[from]) {
        expect(to).not.toBe(from)
        expect(isLifecycleState(to)).toBe(true)
      }
    }
  })

  it("refuses self-transitions and undeclared moves via canTransition", () => {
    expect(canTransition("active", "active")).toBe(false)
    // invited can never jump straight to suspended.
    expect(canTransition("invited", "suspended")).toBe(false)
    // suspended can never fall back to invited.
    expect(canTransition("suspended", "invited")).toBe(false)
  })

  it("keeps the legacy status mirror in lock-step: only active is active", () => {
    for (const state of LIFECYCLE_STATES) {
      expect(statusForLifecycle(state)).toBe(state === "active" ? "active" : "inactive")
    }
  })

  it("rejects unknown state strings", () => {
    expect(isLifecycleState("archived")).toBe(false)
    expect(isLifecycleState(null)).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Joiner
// -----------------------------------------------------------------------------

describe("joiner", () => {
  it("invites into the `invited` state", () => {
    expect(targetStateForAction("invite")).toBe("invited")
  })

  it("activates an invited user (accepting the invitation)", () => {
    const check = validateAction("activate", "invited")
    expect(check).toEqual({ ok: true, to: "active" })
  })

  it("cannot activate a user who is already active", () => {
    const check = validateAction("activate", "active")
    expect(check.ok).toBe(false)
  })

  it("blocks login until the invitation is accepted", () => {
    const decision = evaluateLogin(baseSnapshot({ lifecycleState: "invited" }))
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.code).toBe("invited")
  })

  it("blocks login for an active-but-unverified user only when policy requires it", () => {
    const unverified = baseSnapshot({ emailVerifiedAt: null, requireEmailVerification: true })
    const blocked = evaluateLogin(unverified)
    expect(blocked.allowed).toBe(false)
    if (!blocked.allowed) expect(blocked.code).toBe("email_unverified")

    // Same user, policy off → allowed.
    const relaxed = evaluateLogin({ ...unverified, requireEmailVerification: false })
    expect(relaxed.allowed).toBe(true)
  })

  it("lets a fully-onboarded, verified user in", () => {
    const decision = evaluateLogin(baseSnapshot())
    expect(decision.allowed).toBe(true)
    if (decision.allowed) expect(decision.requiresMfa).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Mover
// -----------------------------------------------------------------------------

describe("mover", () => {
  it("treats role and department assignment as non-transitioning (state-preserving)", () => {
    expect(targetStateForAction("assign_role")).toBeNull()
    expect(targetStateForAction("assign_department")).toBeNull()
    // Structurally valid from any live state; the DB layer owns the guards.
    for (const state of ["active", "suspended", "invited"] as LifecycleState[]) {
      expect(validateAction("assign_role", state)).toEqual({ ok: true, to: null })
    }
  })

  it("suspends an active user and reactivates a suspended one (round trip)", () => {
    expect(validateAction("suspend", "active")).toEqual({ ok: true, to: "suspended" })
    expect(validateAction("reactivate", "suspended")).toEqual({ ok: true, to: "active" })
  })

  it("cannot suspend a user who is not active", () => {
    expect(validateAction("suspend", "suspended").ok).toBe(false)
    expect(validateAction("suspend", "invited").ok).toBe(false)
    expect(validateAction("suspend", "deactivated").ok).toBe(false)
  })

  it("blocks a suspended user at login", () => {
    const decision = evaluateLogin(baseSnapshot({ lifecycleState: "suspended" }))
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.code).toBe("suspended")
  })

  it("requires an MFA challenge for an otherwise-allowed user with MFA enabled", () => {
    const decision = evaluateLogin(baseSnapshot({ mfaEnabled: true }))
    expect(decision.allowed).toBe(true)
    if (decision.allowed) expect(decision.requiresMfa).toBe(true)
  })

  it("expires temporary access purely from the clock, without a state flip", () => {
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 60_000)

    const lapsed = evaluateLogin(baseSnapshot({ accessExpiresAt: past }))
    expect(lapsed.allowed).toBe(false)
    if (!lapsed.allowed) expect(lapsed.code).toBe("temp_access_expired")

    const stillValid = evaluateLogin(baseSnapshot({ accessExpiresAt: future }))
    expect(stillValid.allowed).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// Leaver
// -----------------------------------------------------------------------------

describe("leaver", () => {
  it("can be offboarded (deactivated) from every live state", () => {
    expect(canTransition("invited", "deactivated")).toBe(true)
    expect(canTransition("active", "deactivated")).toBe(true)
    expect(canTransition("suspended", "deactivated")).toBe(true)
  })

  it("blocks a deactivated user at login regardless of temp access or verification", () => {
    const decision = evaluateLogin(
      baseSnapshot({
        lifecycleState: "deactivated",
        accessExpiresAt: new Date(Date.now() + 60_000),
        emailVerifiedAt: new Date(),
      }),
    )
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.code).toBe("deactivated")
  })

  it("is terminal except for an explicit rehire back to active", () => {
    expect(LIFECYCLE_TRANSITIONS.deactivated).toEqual(["active"])
    expect(validateAction("rehire", "deactivated")).toEqual({ ok: true, to: "active" })
    // A deactivated user can never be suspended or re-invited directly.
    expect(validateAction("suspend", "deactivated").ok).toBe(false)
    expect(canTransition("deactivated", "invited")).toBe(false)
  })

  it("rejects rehiring a user who is already active (self-transition)", () => {
    // `rehire` drives to `active`; the graph has no active→active edge, so a
    // structurally meaningless rehire of a live user is refused here. The
    // "only deactivated users may be rehired" semantic guard lives in the DB
    // layer — from `suspended` the active target is a legal transition.
    expect(validateAction("rehire", "active").ok).toBe(false)
    expect(validateAction("rehire", "suspended")).toEqual({ ok: true, to: "active" })
  })
})

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function baseSnapshot(overrides: Partial<UserLifecycleSnapshot> = {}): UserLifecycleSnapshot {
  return {
    lifecycleState: "active",
    accessExpiresAt: null,
    emailVerifiedAt: new Date("2024-01-01T00:00:00Z"),
    mfaEnabled: false,
    requireEmailVerification: false,
    ...overrides,
  }
}
