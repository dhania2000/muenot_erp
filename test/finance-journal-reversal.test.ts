import { beforeEach, describe, expect, it, vi } from "vitest"

// SPEC 165 — Journal Reversal / Adjustment. These tests exercise the
// immutability contract and the audit trail of the manual-journal engine:
//
//   1. validateAdjustmentTarget — the pure guard that decides whether a POSTED
//      journal may be Adjusted / Corrected / Reclassified. Posted accounting
//      history is the ONLY valid target; drafts, reversals and already-reversed
//      vouchers are refused.
//   2. The lifecycle state machine (ACTION_FROM via transitionManualJournal) —
//      an out-of-order action (post a Draft, reverse an Approved) is rejected
//      before any write, and every legal transition writes an audit event.
//   3. "Never silently overwrite posted accounting history" — a Posted journal
//      can neither be edited nor deleted; it must be reversed instead.

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getConnection: vi.fn(),
  logFinanceEvent: vi.fn(),
  assertPeriodOpen: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mocks.query, pool: { getConnection: mocks.getConnection } }))
vi.mock("@/lib/finance-audit", () => ({ logFinanceEvent: mocks.logFinanceEvent }))
vi.mock("@/lib/finance-period-lock", () => ({ assertPeriodOpen: mocks.assertPeriodOpen }))
vi.mock("@/lib/finance-posting", () => ({
  nextLedgerId: vi.fn(async () => "GL-TEST-1"),
  ensureGeneralLedgerColumns: vi.fn(async () => {}),
}))
vi.mock("@/lib/finance-accounts", () => ({
  resolveAccountById: vi.fn(),
  isDebitNature: vi.fn(() => true),
}))
vi.mock("@/lib/finance-calc", () => ({ financialYearFor: vi.fn(() => "2026-2027") }))
vi.mock("@/lib/record-ids", () => ({ nextRecordId: vi.fn(async () => "JE-2026-000001") }))

import {
  validateAdjustmentTarget,
  transitionManualJournal,
  updateManualJournalDraft,
  deleteManualJournal,
  JOURNAL_STATUSES,
  JOURNAL_ACTIONS,
  MANUAL_JOURNAL_ADJUSTMENT_KINDS,
  type JournalStatus,
} from "@/lib/finance-journal"

/**
 * Make the top-level `query` behave like a DB whose one manual journal group
 * currently sits at `status`. getManualJournal reads `approval_status` off the
 * first row; everything else (UPDATE / column self-heal) is a no-op.
 */
function journalAt(status: JournalStatus | null, extra: Record<string, any> = {}) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (/SELECT \* FROM journal_entries/i.test(sql)) {
      return status
        ? [{ approval_status: status, journal_date: "2026-09-10", account_id: "A-1", debit: 100, credit: 0, ...extra }]
        : []
    }
    // information_schema column probes, ALTER, UPDATE, etc.
    return []
  })
}

/** A fake pooled connection that satisfies withJournalLock's advisory lock. */
function mockLockConnection() {
  const conn = {
    query: vi.fn(async (sql: string) => {
      if (/GET_LOCK/i.test(sql)) return [[{ ok: 1 }]]
      return [[]]
    }),
    release: vi.fn(),
  }
  mocks.getConnection.mockResolvedValue(conn)
  return conn
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.assertPeriodOpen.mockResolvedValue(undefined)
  mockLockConnection()
})

describe("SPEC 165 constants — the supported verbs are wired", () => {
  it("exposes Reversed as a terminal status and reverse as an action", () => {
    expect(JOURNAL_STATUSES).toContain("Posted")
    expect(JOURNAL_STATUSES).toContain("Reversed")
    expect(JOURNAL_ACTIONS).toContain("reverse")
    expect(JOURNAL_ACTIONS).toContain("approve")
  })
  it("exposes the three adjustment kinds", () => {
    expect([...MANUAL_JOURNAL_ADJUSTMENT_KINDS]).toEqual(["Adjustment", "Correction", "Reclassification"])
  })
})

describe("validateAdjustmentTarget — only posted history may be corrected", () => {
  it("rejects a missing original", () => {
    expect(validateAdjustmentTarget(null, "Adjustment")).toMatch(/not found/i)
  })

  it("rejects an unknown kind", () => {
    expect(validateAdjustmentTarget({ status: "Posted" }, "Nonsense")).toMatch(/Unknown adjustment kind/i)
  })

  it("rejects adjusting a reversal voucher — the corrected entry is the target", () => {
    const err = validateAdjustmentTarget({ status: "Posted", reversalOf: "JE-2026-000001" }, "Adjustment")
    expect(err).toMatch(/reversal journal cannot be adjusted/i)
  })

  it.each(["Draft", "Pending Approval", "Approved", "Rejected", "Cancelled", "Reversed"])(
    "rejects a %s original (nothing settled to correct)",
    (status) => {
      expect(validateAdjustmentTarget({ status }, "Adjustment")).toMatch(/Only a Posted journal/i)
    },
  )

  it("uses the correct verb per kind in the refusal message", () => {
    expect(validateAdjustmentTarget({ status: "Draft" }, "Correction")).toMatch(/corrected/i)
    expect(validateAdjustmentTarget({ status: "Draft" }, "Reclassification")).toMatch(/reclassified/i)
    expect(validateAdjustmentTarget({ status: "Draft" }, "Adjustment")).toMatch(/adjusted/i)
  })

  it("allows every kind against a Posted, non-reversal original", () => {
    for (const kind of MANUAL_JOURNAL_ADJUSTMENT_KINDS) {
      expect(validateAdjustmentTarget({ status: "Posted", reversalOf: null }, kind)).toBeNull()
    }
  })
})

describe("lifecycle state machine — out-of-order actions are refused", () => {
  it("refuses to post a Draft journal", async () => {
    journalAt("Draft")
    await expect(transitionManualJournal("JE-2026-000001", "post")).rejects.toThrow(/Cannot post a Draft/i)
    expect(mocks.logFinanceEvent).not.toHaveBeenCalled()
  })

  it("refuses to reverse a journal that is not Posted", async () => {
    journalAt("Approved")
    await expect(transitionManualJournal("JE-2026-000001", "reverse")).rejects.toThrow(/Cannot reverse a Approved/i)
  })

  it("refuses to approve a journal that is not Pending Approval", async () => {
    journalAt("Draft")
    await expect(transitionManualJournal("JE-2026-000001", "approve")).rejects.toThrow(/Cannot approve a Draft/i)
  })

  it("refuses any action on a missing journal", async () => {
    journalAt(null)
    await expect(transitionManualJournal("JE-NOPE", "submit")).rejects.toThrow(/not found/i)
  })
})

describe("lifecycle state machine — legal transitions write an audit event", () => {
  it("submit: Draft → Pending Approval, audited", async () => {
    journalAt("Draft")
    const res = await transitionManualJournal("JE-2026-000001", "submit", { actorName: "Alice" })
    expect(res.status).toBe("Pending Approval")
    expect(mocks.logFinanceEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "submitted", entityRef: "JE-2026-000001" }))
  })

  it("approve: Pending Approval → Approved, audited with actor", async () => {
    journalAt("Pending Approval")
    const res = await transitionManualJournal("JE-2026-000001", "approve", { actorName: "Bob" })
    expect(res.status).toBe("Approved")
    expect(mocks.logFinanceEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "approved" }))
  })

  it("reject: Pending Approval → Rejected, reason captured in audit detail", async () => {
    journalAt("Pending Approval")
    const res = await transitionManualJournal("JE-2026-000001", "reject", { reason: "Wrong account" })
    expect(res.status).toBe("Rejected")
    expect(mocks.logFinanceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rejected", detail: { reason: "Wrong account" } }),
    )
  })

  it("cancel: Approved → Cancelled, audited", async () => {
    journalAt("Approved")
    const res = await transitionManualJournal("JE-2026-000001", "cancel")
    expect(res.status).toBe("Cancelled")
    expect(mocks.logFinanceEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "cancelled" }))
  })

  it("releases the advisory lock even when the guard rejects", async () => {
    journalAt("Draft")
    const conn = mockLockConnection()
    await expect(transitionManualJournal("JE-2026-000001", "post")).rejects.toThrow()
    // RELEASE_LOCK runs in finally, and the dedicated connection is returned.
    expect(conn.release).toHaveBeenCalled()
    expect(conn.query).toHaveBeenCalledWith(expect.stringMatching(/RELEASE_LOCK/i), expect.anything())
  })
})

describe("never silently overwrite posted accounting history", () => {
  it("refuses to edit a Posted journal", async () => {
    journalAt("Posted")
    await expect(
      updateManualJournalDraft("JE-2026-000001", {
        journalDate: "2026-09-10",
        lines: [
          { accountId: "A-1", debit: 100, credit: 0 },
          { accountId: "A-2", debit: 0, credit: 100 },
        ],
      }),
    ).rejects.toThrow(/Posted journal cannot be edited/i)
    // No audit "updated" event — the posted history was untouched.
    expect(mocks.logFinanceEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updated" }))
  })

  it("refuses to delete a Posted journal — it must be reversed instead", async () => {
    journalAt("Posted")
    await expect(deleteManualJournal("JE-2026-000001")).rejects.toThrow(/posted journal cannot be deleted/i)
  })

  it("allows deleting an unposted (Draft) journal", async () => {
    journalAt("Draft")
    const conn = {
      query: vi.fn(async (sql: string) => {
        if (/GET_LOCK/i.test(sql)) return [[{ ok: 1 }]]
        if (/^DELETE/i.test(sql.trim())) return [{ affectedRows: 2 }]
        return [[]]
      }),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    }
    mocks.getConnection.mockResolvedValue(conn)
    const res = await deleteManualJournal("JE-2026-000001")
    expect(res.removed).toBe(2)
  })
})
