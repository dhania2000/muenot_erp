import { describe, it, expect, vi } from "vitest"
vi.mock("@/lib/db", () => ({ query: vi.fn(), withTransaction: vi.fn() }))
import { claimOperation, finishOperation, fingerprint } from "@/lib/job-idempotency"
import { ownsJobAttempt } from "@/lib/background-jobs"

/** Serialized transaction simulator: commits snapshots, drops writes on failure.
 * Tests the receipt protocol; real InnoDB locking still needs integration QA.
 */
function database() {
  let committed = new Map<string, any>()
  let effects = 0
  let tail = Promise.resolve()
  async function run(key: string, input: unknown, fail = false) {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>(resolve => { release = resolve })
    await previous
    const snapshot = new Map([...committed].map(([k, v]) => [k, { ...v }]))
    let localEffects = effects
    const connection = { query: vi.fn(async (sql: string, params: any[]) => {
      if (sql.startsWith("INSERT")) {
        if (!snapshot.has(params[0])) snapshot.set(params[0], { request_hash: params[1], execution_id: params[2], result: null })
        return [{}]
      }
      if (sql.startsWith("SELECT")) return [[snapshot.get(params[0])]]
      snapshot.get(params[1]).result = params[0]
      return [{}]
    }) }
    try {
      const receipt = await claimOperation<{ voucher: number }>(connection as any, key, input)
      if (receipt.replay) return receipt.result
      localEffects++
      if (fail) throw new Error("ledger insert failed")
      const result = { voucher: localEffects }
      await finishOperation(connection as any, receipt.key, result)
      committed = snapshot
      effects = localEffects
      return result
    } finally { release() }
  }
  return { run, effects: () => effects }
}

describe(" duplicate execution protocol", () => {
  it("replays a committed result for concurrent identical business keys", async () => {
    const db = database()
    const values = await Promise.all(Array.from({ length: 10 }, () => db.run("tenant:1:period:9", { amount: 100 })))
    expect(values.every(v => v.voucher === 1)).toBe(true)
    expect(db.effects()).toBe(1)
  })
  it("rolls back the receipt and effect together, allowing a safe retry", async () => {
    const db = database()
    await expect(db.run("period:1", { amount: 100 }, true)).rejects.toThrow("ledger")
    expect(db.effects()).toBe(0)
    expect(await db.run("period:1", { amount: 100 })).toEqual({ voucher: 1 })
  })
  it("rejects changed data but permits different operation identities", async () => {
    const db = database()
    await db.run("asset:1:2026-09", { amount: 100 })
    await expect(db.run("asset:1:2026-09", { amount: 200 })).rejects.toThrow("different")
    await db.run("asset:2:2026-09", { amount: 100 })
    expect(db.effects()).toBe(2)
  })
  it("fingerprints consistently without truncation collisions", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }))
    expect(fingerprint("x".repeat(200) + "a")).not.toBe(fingerprint("x".repeat(200) + "b"))
  })
  it("rejects stale execution IDs, attempts and terminal states", () => {
    const current = { status: "running", worker_id: "execution-2", attempts: 2 } as any
    expect(ownsJobAttempt(current, current)).toBe(true)
    expect(ownsJobAttempt({ ...current, worker_id: "execution-1" }, current)).toBe(false)
    expect(ownsJobAttempt({ ...current, attempts: 1 }, current)).toBe(false)
    expect(ownsJobAttempt(current, { ...current, status: "completed" })).toBe(false)
  })
})
