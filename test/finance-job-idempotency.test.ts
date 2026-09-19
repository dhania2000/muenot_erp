import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  conn: { query: vi.fn(), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() },
  claim: vi.fn(), finish: vi.fn(), after: vi.fn(),
}))
vi.mock("@/lib/db", () => ({
  pool: { getConnection: async () => mocks.conn }, query: async () => [{ exists: 1 }],
}))
vi.mock("@/lib/record-ids", () => ({ nextRecordId: async () => "ID-0001" }))
vi.mock("@/lib/finance-accounts", () => ({
  resolveAccount: async () => ({ account_id: "1", account_name: "Account" }),
  resolveAccountById: vi.fn(), isDebitNature: () => true, ensurePurchasePostingAccounts: vi.fn(),
}))
vi.mock("@/lib/job-idempotency", () => ({
  claimOperation: mocks.claim, finishOperation: mocks.finish, ensureIdempotencySchema: async () => {},
}))
import { postLines, type PostingLine } from "@/lib/finance-posting"
const lines: PostingLine[] = [{ role: "receivable", debit: 100, credit: 0 }, { role: "sales", debit: 0, credit: 100 }]
const args = {
  idempotencyKey: "period:1", afterPosting: mocks.after,
  entityType: "provision_accrual_period", entityId: 1, entityRef: "1", date: "2026-09-20",
  financialYear: null, voucherType: "Test", narration: "", sourceModule: "Test",
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.conn.query.mockResolvedValue([[]])
  mocks.claim.mockResolvedValue({ replay: false, key: "receipt", executionId: "uuid" })
  mocks.after.mockResolvedValue(undefined)
})
describe("financial receipt integration", () => {
  it("replays without ledger writes or reapplying source updates", async () => {
    const result = { voucherNo: "original" }
    mocks.claim.mockResolvedValue({ replay: true, result })
    expect(await postLines(lines, args)).toEqual(result)
    expect(mocks.conn.query).not.toHaveBeenCalled()
    expect(mocks.after).not.toHaveBeenCalled()
  })
  it("updates business state and receipt before the common commit", async () => {
    await postLines(lines, args)
    expect(mocks.after.mock.calls[0][0]).toBe(mocks.conn)
    expect(mocks.finish.mock.calls[0][0]).toBe(mocks.conn)
    expect(mocks.after.mock.invocationCallOrder[0]).toBeLessThan(mocks.finish.mock.invocationCallOrder[0])
    expect(mocks.finish.mock.invocationCallOrder[0]).toBeLessThan(mocks.conn.commit.mock.invocationCallOrder[0])
  })
  it("rolls back ledger and receipt when the source update fails", async () => {
    mocks.after.mockRejectedValue(new Error("source update failed"))
    await expect(postLines(lines, args)).rejects.toThrow("source update")
    expect(mocks.conn.commit).not.toHaveBeenCalled()
    expect(mocks.conn.rollback).toHaveBeenCalledOnce()
    expect(mocks.finish).not.toHaveBeenCalled()
  })
})
