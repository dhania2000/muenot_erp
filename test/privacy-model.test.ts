import { describe, expect, it } from "vitest"
import {
  buildSubjectRequestPlan,
  canRunRequest,
  clampCoolingDays,
  computeCoolingEndsAt,
  coolingDaysRemaining,
  effectiveConsent,
  evaluateTenantDeletionReadiness,
  isCoolingElapsed,
  isDuplicateSubjectRequest,
  isProcessingAllowed,
  isTerminalDeletionStatus,
  isTerminalRequestStatus,
  normalizeConsentInput,
  normalizeSubjectRequestInput,
  normalizeTenantDeletionInput,
  requiresApproval,
  TENANT_DELETION_COOLING,
  type SubjectLocationAssessment,
} from "@/lib/privacy-model"

/**
 * Spec24 — pure model contract (#153-156). DB-free tests of the decision logic
 * shared by the consent, DSAR and tenant-deletion stores: consent withdrawal,
 * retention-vs-legal-hold precedence, duplicate detection, the run-gate and the
 * full tenant-deletion readiness gate. These are the guarantees the stores and
 * routes both rely on, so proving them here pins the behavior independently of
 * any database.
 */

const loc = (o: Partial<SubjectLocationAssessment> & { key: string }): SubjectLocationAssessment => ({
  label: o.key,
  matches: 1,
  retained: false,
  held: false,
  anonymizable: true,
  ...o,
})

describe("consent effective state (withdrawal)", () => {
  it("returns null with no events", () => {
    expect(effectiveConsent([])).toBeNull()
  })

  it("the latest event wins regardless of input order", () => {
    const events = [
      { status: "granted" as const, at: "2027-01-01T00:00:00Z" },
      { status: "withdrawn" as const, at: "2027-01-03T00:00:00Z" },
      { status: "granted" as const, at: "2027-01-02T00:00:00Z" },
    ]
    expect(effectiveConsent(events)).toBe("withdrawn")
    expect(isProcessingAllowed(effectiveConsent(events))).toBe(false)
  })

  it("a fresh grant after a withdrawal re-establishes consent", () => {
    const events = [
      { status: "granted" as const, at: "2027-01-01T00:00:00Z" },
      { status: "withdrawn" as const, at: "2027-01-02T00:00:00Z" },
      { status: "granted" as const, at: "2027-01-03T00:00:00Z" },
    ]
    expect(effectiveConsent(events)).toBe("granted")
    expect(isProcessingAllowed("granted")).toBe(true)
  })
})

describe("consent input validation", () => {
  it("normalizes and lower-cases the subject email", () => {
    const out = normalizeConsentInput({ subjectEmail: "  Jane@Example.COM ", purpose: "marketing" })
    expect(out.subjectEmail).toBe("jane@example.com")
    expect(out.method).toBe("explicit_optin")
  })

  it("rejects an invalid email or unknown purpose", () => {
    expect(() => normalizeConsentInput({ subjectEmail: "nope", purpose: "marketing" })).toThrow(/valid subject email/i)
    expect(() => normalizeConsentInput({ subjectEmail: "a@b.co", purpose: "weather" })).toThrow(/valid consent purpose/i)
  })
})

describe("DSAR run-gate and approval", () => {
  it("only erase/anonymize require approval", () => {
    expect(requiresApproval("export")).toBe(false)
    expect(requiresApproval("erase")).toBe(true)
    expect(requiresApproval("anonymize")).toBe(true)
  })

  it("export runs from pending; destructive kinds need approval first", () => {
    expect(canRunRequest("export", "pending")).toBe(true)
    expect(canRunRequest("erase", "pending")).toBe(false)
    expect(canRunRequest("erase", "approved")).toBe(true)
  })

  it("a failed request may always be retried; terminal states cannot run", () => {
    expect(canRunRequest("erase", "failed")).toBe(true)
    expect(canRunRequest("export", "completed")).toBe(false)
    expect(isTerminalRequestStatus("completed")).toBe(true)
    expect(isTerminalRequestStatus("rejected")).toBe(true)
    expect(isTerminalRequestStatus("pending")).toBe(false)
  })
})

describe("duplicate subject request detection", () => {
  const existing = [
    { kind: "erase" as const, subjectEmail: "jane@example.com", status: "pending" as const },
    { kind: "export" as const, subjectEmail: "jane@example.com", status: "completed" as const },
  ]

  it("blocks a second OPEN request of the same kind + subject (case-insensitive)", () => {
    expect(isDuplicateSubjectRequest({ kind: "erase", subjectEmail: "JANE@example.com" }, existing)).toBe(true)
  })

  it("does not block when the prior request is terminal", () => {
    expect(isDuplicateSubjectRequest({ kind: "export", subjectEmail: "jane@example.com" }, existing)).toBe(false)
  })

  it("does not block a different kind or subject", () => {
    expect(isDuplicateSubjectRequest({ kind: "anonymize", subjectEmail: "jane@example.com" }, existing)).toBe(false)
    expect(isDuplicateSubjectRequest({ kind: "erase", subjectEmail: "other@example.com" }, existing)).toBe(false)
  })

  it("normalizes the request kind and email", () => {
    expect(() => normalizeSubjectRequestInput({ kind: "erase", subjectEmail: "a@b.co" })).not.toThrow()
    expect(() => normalizeSubjectRequestInput({ kind: "burn", subjectEmail: "a@b.co" })).toThrow(/valid request type/i)
  })
})

describe("subject request plan — retention vs legal-hold precedence", () => {
  it("a legal hold ALWAYS blocks a location, overriding everything", () => {
    const plan = buildSubjectRequestPlan("erase", [loc({ key: "a", held: true, retained: false })])
    expect(plan.blockedLocations.map((l) => l.key)).toEqual(["a"])
    expect(plan.hasLegalHoldConflict).toBe(true)
    expect(plan.eraseLocations).toHaveLength(0)
  })

  it("a retention obligation downgrades an erase to anonymize where possible", () => {
    const plan = buildSubjectRequestPlan("erase", [loc({ key: "a", retained: true, anonymizable: true })])
    expect(plan.anonymizeLocations.map((l) => l.key)).toEqual(["a"])
    expect(plan.eraseLocations).toHaveLength(0)
    expect(plan.hasRetentionConflict).toBe(true)
  })

  it("a retained, non-anonymizable location is blocked (cannot erase, cannot scrub)", () => {
    const plan = buildSubjectRequestPlan("erase", [loc({ key: "a", retained: true, anonymizable: false })])
    expect(plan.blockedLocations.map((l) => l.key)).toEqual(["a"])
  })

  it("erasable, unretained locations are erased; empty locations are skipped", () => {
    const plan = buildSubjectRequestPlan("erase", [
      loc({ key: "erase-me", retained: false }),
      loc({ key: "empty", matches: 0 }),
    ])
    expect(plan.eraseLocations.map((l) => l.key)).toEqual(["erase-me"])
    expect(plan.emptyLocations.map((l) => l.key)).toEqual(["empty"])
  })

  it("an explicit anonymize scrubs anonymizable locations", () => {
    const plan = buildSubjectRequestPlan("anonymize", [loc({ key: "a", anonymizable: true })])
    expect(plan.anonymizeLocations.map((l) => l.key)).toEqual(["a"])
    expect(plan.hasRetentionConflict).toBe(false)
  })
})

describe("tenant deletion cooling window", () => {
  it("clamps the cooling days into the allowed band", () => {
    expect(clampCoolingDays(1)).toBe(TENANT_DELETION_COOLING.MIN_DAYS)
    expect(clampCoolingDays(9999)).toBe(TENANT_DELETION_COOLING.MAX_DAYS)
    expect(clampCoolingDays("abc")).toBe(TENANT_DELETION_COOLING.DEFAULT_DAYS)
    expect(clampCoolingDays(30)).toBe(30)
  })

  it("computes the end and remaining days", () => {
    const start = new Date("2027-01-01T00:00:00Z")
    const ends = computeCoolingEndsAt(start, 30)
    expect(ends.toISOString()).toBe("2027-01-31T00:00:00.000Z")
    expect(isCoolingElapsed(ends, new Date("2027-01-15T00:00:00Z"))).toBe(false)
    expect(isCoolingElapsed(ends, new Date("2027-02-01T00:00:00Z"))).toBe(true)
    expect(coolingDaysRemaining(ends, new Date("2027-01-21T00:00:00Z"))).toBe(10)
    expect(coolingDaysRemaining(ends, new Date("2027-02-02T00:00:00Z"))).toBe(0)
  })

  it("defaults the cooling days when none supplied", () => {
    expect(normalizeTenantDeletionInput({}).coolingDays).toBe(TENANT_DELETION_COOLING.DEFAULT_DAYS)
    expect(normalizeTenantDeletionInput({ coolingDays: 5 }).coolingDays).toBe(TENANT_DELETION_COOLING.MIN_DAYS)
  })
})

describe("tenant deletion readiness gate", () => {
  const base = {
    status: "export_ready" as const,
    coolingEndsAt: new Date("2027-01-01T00:00:00Z"),
    exportCompleted: true,
    activeLegalHolds: 0,
    retentionProven: true,
    now: new Date("2027-02-01T00:00:00Z"),
  }

  it("approves only when all four obligations are met", () => {
    const r = evaluateTenantDeletionReadiness(base)
    expect(r.canApprove).toBe(true)
    expect(r.checks).toEqual({ coolingElapsed: true, exportCompleted: true, noLegalHold: true, retentionProven: true })
  })

  it("an active legal hold blocks approval absolutely", () => {
    const r = evaluateTenantDeletionReadiness({ ...base, activeLegalHolds: 2 })
    expect(r.canApprove).toBe(false)
    expect(r.reasons.join(" ")).toMatch(/2 active legal hold/i)
  })

  it("blocks while cooling has not elapsed, without an export, or without retention proof", () => {
    expect(evaluateTenantDeletionReadiness({ ...base, now: new Date("2026-12-15T00:00:00Z") }).canApprove).toBe(false)
    expect(evaluateTenantDeletionReadiness({ ...base, exportCompleted: false }).canApprove).toBe(false)
    expect(evaluateTenantDeletionReadiness({ ...base, retentionProven: false }).canApprove).toBe(false)
  })

  it("execution additionally requires the request to be approved", () => {
    expect(evaluateTenantDeletionReadiness({ ...base, status: "export_ready" }).canExecute).toBe(false)
    expect(evaluateTenantDeletionReadiness({ ...base, status: "approved" }).canExecute).toBe(true)
  })

  it("a terminal request can neither be approved nor executed", () => {
    const r = evaluateTenantDeletionReadiness({ ...base, status: "executed" })
    expect(r.canApprove).toBe(false)
    expect(r.canExecute).toBe(false)
    expect(isTerminalDeletionStatus("executed")).toBe(true)
    expect(isTerminalDeletionStatus("cancelled")).toBe(true)
    expect(isTerminalDeletionStatus("requested")).toBe(false)
  })
})
