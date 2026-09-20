import { describe, expect, it, vi, beforeEach } from "vitest"
const db = vi.hoisted(() => ({ sql: vi.fn(), query: vi.fn() }))
vi.mock("@/lib/db", () => ({ query: db.query, withTransaction: (fn: any) => fn({ query: db.sql }) }))
vi.mock("@/lib/background-jobs", () => ({ ensureBackgroundJobSchema: async () => {} }))
import { classifyJobFailure, retryDisposition } from "@/lib/job-retry-policy"
import { retryDeadLetter } from "@/lib/job-manual-retry"

describe("SPEC 45 retry decisions", () => {
  it.each([
    [{ code: "ECONNREFUSED" }, "transient"],
    [{ responseCode: 450, code: "EENVELOPE" }, "transient"],
    [{ responseCode: 550 }, "permanent"],
    [{ status: 429 }, "transient"],
    [{ status: 503 }, "transient"],
    [{ status: 401 }, "permanent"],
    [{ code: "EAUTH" }, "permanent"],
    [{ code: "ECONNRESET" }, "uncertain"],
    [{ code: "ETIMEDOUT" }, "uncertain"],
    [new Error("unknown"), "uncertain"],
  ])("classifies %j as %s", (error, kind) => expect(classifyJobFailure(error)).toBe(kind))
  it("bounds automatic retries and never retries permanent/uncertain failures", () => {
    expect(retryDisposition("transient", 1, 3)).toBe("queued")
    expect(retryDisposition("transient", 3, 3)).toBe("dead_letter")
    expect(retryDisposition("permanent", 1, 3)).toBe("dead_letter")
    expect(retryDisposition("uncertain", 1, 3)).toBe("dead_letter")
    expect(classifyJobFailure({ status: 503 }, true)).toBe("uncertain")
  })
})
describe("manual retry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.sql.mockResolvedValue([{}])
  })
  it("adds one attempt, preserves identity and records the operator atomically", async () => {
    db.sql.mockResolvedValueOnce([[{ id: 5, status: "dead_letter", attempts: 3, result: { failureKind: "transient" } }]])
    expect(await retryDeadLetter(5, 3, 99, false)).toEqual({ id: 5, status: "queued" })
    expect(db.sql.mock.calls[0][0]).toContain("FOR UPDATE")
    expect(db.sql.mock.calls[1][0]).toContain("max_attempts=attempts+1")
    expect(db.sql.mock.calls[1][0]).not.toContain("attempts=0")
    expect(JSON.parse(db.sql.mock.calls[2][1][2])).toMatchObject({ actorId: 99, expectedAttempt: 3 })
  })
  it.each(["queued", "running", "completed", "cancelled"])("rejects duplicate replay for %s jobs", async status => {
    db.sql.mockResolvedValueOnce([[{ id: 5, status, attempts: 3 }]])
    await expect(retryDeadLetter(5, 3, 99, true)).rejects.toThrow("Job changed")
    expect(db.sql).toHaveBeenCalledTimes(1)
  })
  it("rejects stale attempts and requires acknowledgement for uncertain outcomes", async () => {
    db.sql.mockResolvedValueOnce([[{ status: "dead_letter", attempts: 4 }]])
    await expect(retryDeadLetter(5, 3, 99, true)).rejects.toThrow("Job changed")
    db.sql.mockResolvedValueOnce([[{ status: "dead_letter", attempts: 3, result: { failureKind: "uncertain" } }]])
    await expect(retryDeadLetter(5, 3, 99, false)).rejects.toThrow("Confirm")
  })
})
