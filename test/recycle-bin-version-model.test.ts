import { describe, it, expect } from "vitest"
import {
  RECORD_VERSION_LIMITS,
  evaluateTransition,
  isEditStale,
  isLiveRowStale,
  isRecordVersionStatus,
  nextVersionNo,
  normalizeDecisionNote,
  normalizeVersionInput,
  type TransitionContext,
} from "@/lib/recycle-bin/version-model"

/**
 * Spec35 — pure proof for versioned sensitive edits. Covers the two scenarios
 * the spec calls out for this layer — STALE VERSIONS and CONCURRENT EDIT — plus
 * the draft/pending/approved/published state machine, segregation of duties
 * (no self-approval), sequencing and input normalization.
 *
 * The engine under test is DB-free (lib/recycle-bin/version-model.ts).
 */

function ctx(partial: Partial<TransitionContext> = {}): TransitionContext {
  return {
    status: "approved",
    baseVersionNo: 0,
    currentPublishedVersionNo: 0,
    createdBy: 1,
    actorUserId: 2,
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Sequencing + normalization
// ---------------------------------------------------------------------------

describe("nextVersionNo", () => {
  it("starts at 1 and increments the current max", () => {
    expect(nextVersionNo(null)).toBe(1)
    expect(nextVersionNo(0)).toBe(1)
    expect(nextVersionNo(4)).toBe(5)
    expect(nextVersionNo(-3)).toBe(1)
  })
})

describe("normalizeVersionInput", () => {
  it("requires entity type, id and a non-empty payload object", () => {
    expect(() => normalizeVersionInput({ entityPk: "1", payload: { a: 1 } })).toThrow(/entity type/i)
    expect(() => normalizeVersionInput({ entityType: "client", payload: { a: 1 } })).toThrow(/entity id/i)
    expect(() => normalizeVersionInput({ entityType: "client", entityPk: "1", payload: {} })).toThrow(/at least one/i)
    expect(() => normalizeVersionInput({ entityType: "client", entityPk: "1", payload: [] })).toThrow(/payload object/i)
  })

  it("rejects an over-sized payload", () => {
    const payload = { note: "x".repeat(RECORD_VERSION_LIMITS.PAYLOAD_BYTES + 1) }
    expect(() => normalizeVersionInput({ entityType: "client", entityPk: "1", payload })).toThrow(/too large/i)
  })

  it("normalizes a valid input and coerces a bad base version to 0", () => {
    const out = normalizeVersionInput({
      entityType: "  client  ",
      entityPk: " 7 ",
      baseVersionNo: -5,
      payload: { credit_limit: 5000 },
      summary: "  raise limit  ",
    })
    expect(out).toEqual({
      entityType: "client",
      entityPk: "7",
      baseVersionNo: 0,
      payload: { credit_limit: 5000 },
      summary: "raise limit",
    })
  })

  it("normalizes decision notes, empty -> null and capped", () => {
    expect(normalizeDecisionNote("  looks good ")).toBe("looks good")
    expect(normalizeDecisionNote("   ")).toBeNull()
    expect(normalizeDecisionNote("x".repeat(9999))).toHaveLength(RECORD_VERSION_LIMITS.DECISION_NOTE)
  })

  it("recognizes the six version statuses", () => {
    for (const s of ["draft", "pending", "approved", "published", "rejected", "superseded"]) {
      expect(isRecordVersionStatus(s)).toBe(true)
    }
    expect(isRecordVersionStatus("live")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Staleness / concurrency
// ---------------------------------------------------------------------------

describe("isEditStale", () => {
  it("is stale when a newer version was published after the author branched", () => {
    expect(isEditStale(2, 3)).toBe(true)
  })

  it("is not stale at or below the base, and base 0 is never stale", () => {
    expect(isEditStale(2, 2)).toBe(false)
    expect(isEditStale(3, 2)).toBe(false)
    expect(isEditStale(0, 9)).toBe(false)
  })
})

describe("isLiveRowStale", () => {
  const equals = (_f: string, a: unknown, b: unknown) => String(a ?? "") === String(b ?? "")

  it("is stale when the optimistic-lock counter advanced", () => {
    expect(
      isLiveRowStale({ baseRowVersion: 4, currentRowVersion: 5, baseValues: {}, currentValues: {}, equals }),
    ).toBe(true)
  })

  it("is stale when a captured field no longer holds the author's value", () => {
    expect(
      isLiveRowStale({
        baseRowVersion: null,
        currentRowVersion: null,
        baseValues: { credit_limit: 5000 },
        currentValues: { credit_limit: 8000 },
        equals,
      }),
    ).toBe(true)
  })

  it("is fresh when the counter and all captured values match", () => {
    expect(
      isLiveRowStale({
        baseRowVersion: 4,
        currentRowVersion: 4,
        baseValues: { credit_limit: 5000 },
        currentValues: { credit_limit: 5000, other: "ignored" },
        equals,
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Status transitions — the draft -> ... -> published state machine
// ---------------------------------------------------------------------------

describe("evaluateTransition — allowed states", () => {
  it("submit only from draft", () => {
    expect(evaluateTransition("submit", ctx({ status: "draft" }))).toEqual({ ok: true, next: "pending" })
    const bad = evaluateTransition("submit", ctx({ status: "pending" }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.code).toBe("WRONG_STATUS")
      expect(bad.status).toBe(409)
    }
  })

  it("approve only from pending", () => {
    expect(evaluateTransition("approve", ctx({ status: "pending" }))).toEqual({ ok: true, next: "approved" })
    expect(evaluateTransition("approve", ctx({ status: "approved" })).ok).toBe(false)
  })

  it("publish only from approved", () => {
    expect(evaluateTransition("publish", ctx({ status: "approved" }))).toEqual({ ok: true, next: "published" })
    expect(evaluateTransition("publish", ctx({ status: "draft" })).ok).toBe(false)
  })

  it("reject is allowed from draft/pending/approved", () => {
    for (const status of ["draft", "pending", "approved"] as const) {
      expect(evaluateTransition("reject", ctx({ status }))).toEqual({ ok: true, next: "rejected" })
    }
  })
})

// ---------------------------------------------------------------------------
// Segregation of duties — no self-approval
// ---------------------------------------------------------------------------

describe("evaluateTransition — segregation of duties", () => {
  it("refuses to let the author approve their own version (403)", () => {
    const decision = evaluateTransition("approve", ctx({ status: "pending", createdBy: 5, actorUserId: 5 }))
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe("SELF_APPROVAL")
      expect(decision.status).toBe(403)
    }
  })

  it("allows a different approver", () => {
    expect(evaluateTransition("approve", ctx({ status: "pending", createdBy: 5, actorUserId: 6 })).ok).toBe(true)
  })

  it("can disable segregation explicitly (e.g. platform override)", () => {
    expect(
      evaluateTransition(
        "approve",
        ctx({ status: "pending", createdBy: 5, actorUserId: 5, enforceSegregation: false }),
      ).ok,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Concurrent edit — the loser is caught STALE at publish, not clobbering
// ---------------------------------------------------------------------------

describe("evaluateTransition — publish staleness (concurrent edit)", () => {
  it("blocks publish when a newer version was published since branching", () => {
    const decision = evaluateTransition("publish", ctx({ status: "approved", baseVersionNo: 2, currentPublishedVersionNo: 3 }))
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe("STALE")
      expect(decision.status).toBe(409)
    }
  })

  it("blocks publish when the live row drifted underneath the proposal", () => {
    const decision = evaluateTransition("publish", ctx({ status: "approved", liveStale: true }))
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.code).toBe("STALE")
  })

  it("simulates two authors branching from base 2: first publishes, second is superseded", () => {
    // Author A and B both branch from published version 2.
    const a = evaluateTransition("publish", ctx({ status: "approved", baseVersionNo: 2, currentPublishedVersionNo: 2 }))
    expect(a).toEqual({ ok: true, next: "published" })
    // A's publish advances the live baseline to 3. B now loses the race.
    const b = evaluateTransition("publish", ctx({ status: "approved", baseVersionNo: 2, currentPublishedVersionNo: 3 }))
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.code).toBe("STALE")
  })

  it("still enforces status before staleness (approved required)", () => {
    const decision = evaluateTransition("publish", ctx({ status: "pending", baseVersionNo: 2, currentPublishedVersionNo: 3 }))
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.code).toBe("WRONG_STATUS")
  })
})
