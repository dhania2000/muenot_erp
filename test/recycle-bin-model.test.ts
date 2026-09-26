import { describe, it, expect } from "vitest"
import {
  DEFAULT_RESTORE_WINDOW_DAYS,
  RECYCLE_BIN_LIMITS,
  clampRestoreWindowDays,
  computeRestoreDeadline,
  evaluatePurge,
  evaluateRestore,
  isPurgeableByExpiry,
  isRestoreWindowExpired,
  isRecycleEntryStatus,
  normalizeDeleteReason,
  restoreDaysRemaining,
  type RecycleEntryState,
} from "@/lib/recycle-bin/model"

/**
 * Spec35 — pure proof for soft delete / recycle bin recovery. Covers the two
 * scenarios the spec calls out for this layer — HARD-DELETE EXPIRY and
 * WRONG-TENANT RESTORE — plus the restore-window arithmetic, legal-hold
 * protection and input normalization the store and routes rely on.
 *
 * The gates under test are DB-free (lib/recycle-bin/model.ts), so the whole
 * decision surface is exercised deterministically here.
 */

const NOW = new Date("2026-06-01T00:00:00Z")

function entry(partial: Partial<RecycleEntryState> = {}): RecycleEntryState {
  return {
    tenantId: 1,
    status: "recycled",
    // Deleted 10 days ago with a 30-day window -> window still open.
    restoreDeadline: new Date("2026-06-21T00:00:00Z"),
    legalHold: false,
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Restore-window arithmetic
// ---------------------------------------------------------------------------

describe("restore-window arithmetic", () => {
  it("computes the deadline from the delete time + window", () => {
    const deadline = computeRestoreDeadline(new Date("2026-06-01T00:00:00Z"), 30)
    expect(deadline.toISOString()).toBe("2026-07-01T00:00:00.000Z")
  })

  it("uses the platform default when no window is given", () => {
    const deadline = computeRestoreDeadline(new Date("2026-06-01T00:00:00Z"))
    const expected = new Date("2026-06-01T00:00:00Z").getTime() + DEFAULT_RESTORE_WINDOW_DAYS * 86_400_000
    expect(deadline.getTime()).toBe(expected)
  })

  it("clamps the window into the allowed range", () => {
    expect(clampRestoreWindowDays(0)).toBe(RECYCLE_BIN_LIMITS.MIN_RESTORE_DAYS)
    expect(clampRestoreWindowDays(999_999)).toBe(RECYCLE_BIN_LIMITS.MAX_RESTORE_DAYS)
    expect(clampRestoreWindowDays("45")).toBe(45)
    expect(clampRestoreWindowDays("nope")).toBe(DEFAULT_RESTORE_WINDOW_DAYS)
  })

  it("detects an expired window at or past the deadline", () => {
    const deadline = new Date("2026-06-10T00:00:00Z")
    expect(isRestoreWindowExpired(deadline, new Date("2026-06-09T23:59:59Z"))).toBe(false)
    expect(isRestoreWindowExpired(deadline, new Date("2026-06-10T00:00:00Z"))).toBe(true)
    expect(isRestoreWindowExpired(deadline, new Date("2026-06-11T00:00:00Z"))).toBe(true)
    expect(isRestoreWindowExpired(null, NOW)).toBe(false)
  })

  it("reports whole days remaining, flooring to 0 once past", () => {
    expect(restoreDaysRemaining(new Date("2026-06-21T00:00:00Z"), NOW)).toBe(20)
    expect(restoreDaysRemaining(new Date("2026-05-20T00:00:00Z"), NOW)).toBe(0)
    expect(restoreDaysRemaining(null, NOW)).toBe(0)
  })
})

describe("input normalization", () => {
  it("normalizes and caps the delete reason, empty -> null", () => {
    expect(normalizeDeleteReason("  duplicate record  ")).toBe("duplicate record")
    expect(normalizeDeleteReason("   ")).toBeNull()
    expect(normalizeDeleteReason(null)).toBeNull()
    expect(normalizeDeleteReason("x".repeat(5000))).toHaveLength(RECYCLE_BIN_LIMITS.REASON)
  })

  it("recognizes only the three ledger statuses", () => {
    expect(isRecycleEntryStatus("recycled")).toBe(true)
    expect(isRecycleEntryStatus("restored")).toBe(true)
    expect(isRecycleEntryStatus("purged")).toBe(true)
    expect(isRecycleEntryStatus("deleted")).toBe(false)
    expect(isRecycleEntryStatus(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Restore gate — wrong tenant wins first, then state, hold, window
// ---------------------------------------------------------------------------

describe("evaluateRestore", () => {
  it("allows an in-window, unheld, same-tenant restore", () => {
    expect(evaluateRestore(entry(), { tenantId: 1, now: NOW })).toEqual({ ok: true })
  })

  it("rejects a WRONG-TENANT restore as a 404 (never leaks existence)", () => {
    const decision = evaluateRestore(entry({ tenantId: 2 }), { tenantId: 1, now: NOW })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe("WRONG_TENANT")
      expect(decision.status).toBe(404)
    }
  })

  it("checks tenant BEFORE window/hold so a cross-tenant caller learns nothing", () => {
    // Expired + held, but belongs to another tenant: must still surface as WRONG_TENANT.
    const decision = evaluateRestore(
      entry({ tenantId: 2, legalHold: true, restoreDeadline: new Date("2026-05-01T00:00:00Z") }),
      { tenantId: 1, now: NOW },
    )
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.code).toBe("WRONG_TENANT")
  })

  it("refuses to restore an entry that is not currently recycled", () => {
    for (const status of ["restored", "purged"] as const) {
      const decision = evaluateRestore(entry({ status }), { tenantId: 1, now: NOW })
      expect(decision.ok).toBe(false)
      if (!decision.ok) {
        expect(decision.code).toBe("NOT_RECYCLED")
        expect(decision.status).toBe(409)
      }
    }
  })

  it("a live legal hold blocks restore (423) even inside the window", () => {
    const decision = evaluateRestore(entry(), { tenantId: 1, legalHoldActive: true, now: NOW })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe("LEGAL_HOLD")
      expect(decision.status).toBe(423)
    }
  })

  it("live hold coverage overrides the stale snapshot flag", () => {
    // Snapshot said held, but the hold was released -> restore is allowed.
    expect(evaluateRestore(entry({ legalHold: true }), { tenantId: 1, legalHoldActive: false, now: NOW })).toEqual({
      ok: true,
    })
  })

  it("rejects a restore once the window has closed (410)", () => {
    const decision = evaluateRestore(entry({ restoreDeadline: new Date("2026-05-01T00:00:00Z") }), {
      tenantId: 1,
      now: NOW,
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe("WINDOW_EXPIRED")
      expect(decision.status).toBe(410)
    }
  })

  it("lets an admin override the closed window explicitly", () => {
    expect(
      evaluateRestore(entry({ restoreDeadline: new Date("2026-05-01T00:00:00Z") }), {
        tenantId: 1,
        overrideWindow: true,
        now: NOW,
      }),
    ).toEqual({ ok: true })
  })

  it("a legal hold still wins even with overrideWindow", () => {
    const decision = evaluateRestore(entry({ restoreDeadline: new Date("2026-05-01T00:00:00Z") }), {
      tenantId: 1,
      overrideWindow: true,
      legalHoldActive: true,
      now: NOW,
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.code).toBe("LEGAL_HOLD")
  })
})

// ---------------------------------------------------------------------------
// Purge (hard-delete) gate — expiry vs manual
// ---------------------------------------------------------------------------

describe("evaluatePurge — hard-delete expiry", () => {
  it("the expiry sweep only purges entries whose window has CLOSED", () => {
    const open = evaluatePurge(entry(), { tenantId: 1, mode: "expiry", now: NOW })
    expect(open.ok).toBe(false)
    if (!open.ok) {
      expect(open.code).toBe("WINDOW_OPEN")
      expect(open.status).toBe(409)
    }

    const expired = evaluatePurge(entry({ restoreDeadline: new Date("2026-05-01T00:00:00Z") }), {
      tenantId: 1,
      mode: "expiry",
      now: NOW,
    })
    expect(expired).toEqual({ ok: true })
  })

  it("isPurgeableByExpiry mirrors the expiry gate", () => {
    expect(isPurgeableByExpiry(entry(), { tenantId: 1, now: NOW })).toBe(false)
    expect(
      isPurgeableByExpiry(entry({ restoreDeadline: new Date("2026-05-01T00:00:00Z") }), { tenantId: 1, now: NOW }),
    ).toBe(true)
  })

  it("a manual purge may run while the window is still open", () => {
    expect(evaluatePurge(entry(), { tenantId: 1, mode: "manual", now: NOW })).toEqual({ ok: true })
  })

  it("never purges another tenant's entry (WRONG_TENANT, 404)", () => {
    const decision = evaluatePurge(entry({ tenantId: 2, restoreDeadline: new Date("2026-05-01T00:00:00Z") }), {
      tenantId: 1,
      mode: "expiry",
      now: NOW,
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.code).toBe("WRONG_TENANT")
  })

  it("never purges a legally-held record, even after expiry", () => {
    const decision = evaluatePurge(entry({ restoreDeadline: new Date("2026-05-01T00:00:00Z") }), {
      tenantId: 1,
      legalHoldActive: true,
      mode: "expiry",
      now: NOW,
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe("LEGAL_HOLD")
      expect(decision.status).toBe(423)
    }
  })

  it("never purges an entry that is already restored/purged", () => {
    const decision = evaluatePurge(entry({ status: "purged" }), { tenantId: 1, mode: "manual", now: NOW })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.code).toBe("NOT_RECYCLED")
  })
})
