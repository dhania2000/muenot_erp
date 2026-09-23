import { beforeEach, describe, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ query: vi.fn(), connQuery: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), audit: vi.fn(), keys: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mock.query, pool: { getConnection: async () => ({ query: mock.connQuery, beginTransaction: mock.begin, commit: mock.commit, rollback: mock.rollback, release: mock.release }) } }))
vi.mock("@/lib/platform-roles", () => ({ recordPlatformAudit: mock.audit }))
vi.mock("@/lib/api-keys-store", () => ({ listApiKeys: mock.keys }))

import { enforceSharedRateLimit, enforceSharedRateLimits } from "@/lib/api-platform/rate-limit-store"
import { validateRatePolicyInput } from "@/lib/api-platform/rate-limit-policies"

const tier = { second: 2, minute: 10, hour: 100, day: 1000 }
const counters = new Map<string, number>()
const abuse = new Map<string, { strikes: number; window_reset_ms: number; blocked_until_ms: number }>()
function key(params: unknown[]) { return params.slice(0, 4).join(":") }
beforeEach(() => {
  vi.clearAllMocks(); counters.clear(); abuse.clear()
  mock.query.mockResolvedValue([])
  mock.rollback.mockResolvedValue(undefined)
  mock.keys.mockResolvedValue([{ id: 5, name: "Shop API" }])
  mock.connQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const k = key(params)
    if (sql.includes("api_rate_limit_abuse")) {
      if (sql.startsWith("INSERT")) {
        if (!abuse.has(k)) abuse.set(k, { strikes: 0, window_reset_ms: 0, blocked_until_ms: 0 })
        return [{ affectedRows: 1 }]
      }
      if (sql.startsWith("SELECT")) return [[abuse.get(k)]]
      if (sql.startsWith("UPDATE")) {
        abuse.set(`${params[3]}:${params[4]}`, { strikes: Number(params[0]), window_reset_ms: Number(params[1]), blocked_until_ms: Number(params[2]) })
        return [{ affectedRows: 1 }]
      }
    }
    if (sql.startsWith("INSERT")) { if (!counters.has(k)) counters.set(k, 0); return [{ affectedRows: 1 }] }
    if (sql.startsWith("SELECT")) return [[{ request_count: counters.get(k) ?? 0 }]]
    if (sql.startsWith("UPDATE")) { counters.set(k, (counters.get(k) ?? 0) + 1); return [{ affectedRows: 1 }] }
    return []
  })
})

describe("shared MySQL rate limits", () => {
  it("enforces a burst window and emits 429 headers without consuming other windows", async () => {
    expect((await enforceSharedRateLimit(7, "apiv1:key:5", tier)).allowed).toBe(true)
    expect((await enforceSharedRateLimit(7, "apiv1:key:5", tier)).allowed).toBe(true)
    const blocked = await enforceSharedRateLimit(7, "apiv1:key:5", tier)
    expect(blocked).toMatchObject({ allowed: false, window: "second" })
    expect(blocked.headers["Retry-After"]).toBeDefined()
    expect(blocked.headers["X-RateLimit-Remaining"]).toBe("8")
    expect(mock.connQuery.mock.calls.some(([sql]) => String(sql).includes("FOR UPDATE"))).toBe(true)
  })
  it("keeps tenants isolated even with the same API-key scope", async () => {
    await enforceSharedRateLimit(7, "apiv1:key:5", { ...tier, second: 1 })
    expect((await enforceSharedRateLimit(7, "apiv1:key:5", { ...tier, second: 1 })).allowed).toBe(false)
    expect((await enforceSharedRateLimit(8, "apiv1:key:5", { ...tier, second: 1 })).allowed).toBe(true)
  })
  it("does not consume any budget when one of several overlapping policies blocks", async () => {
    await enforceSharedRateLimit(7, "apiv1:policy:9", { ...tier, second: 1 })
    const before = [...counters.values()].reduce((a, b) => a + b, 0)
    const result = await enforceSharedRateLimits(7, [{ scope: "apiv1:key:5", tier }, { scope: "apiv1:policy:9", tier: { ...tier, second: 1 } }])
    expect(result.allowed).toBe(false)
    expect([...counters.values()].reduce((a, b) => a + b, 0)).toBe(before)
  })
  it("fails closed on database failure", async () => {
    mock.connQuery.mockRejectedValueOnce(new Error("db down"))
    await expect(enforceSharedRateLimit(7, "apiv1:key:5", tier)).rejects.toThrow("db down")
    expect(mock.rollback).toHaveBeenCalled()
  })
  it("temporarily blocks repeat violators across requests", async () => {
    await enforceSharedRateLimit(7, "apiv1:key:5", { ...tier, second: 1 })
    for (let index = 0; index < 9; index++) {
      expect((await enforceSharedRateLimit(7, "apiv1:key:5", { ...tier, second: 1 })).allowed).toBe(false)
    }
    const tripped = await enforceSharedRateLimit(7, "apiv1:key:5", { ...tier, second: 1 })
    expect(tripped).toMatchObject({ allowed: false, abuse: true, retryAfter: 300 })
    expect((await enforceSharedRateLimit(7, "apiv1:key:5", { ...tier, second: 1 })).abuse).toBe(true)
  })
})

describe("rate policy validation", () => {
  const value = { name: "Tighten Shop API", targetType: "api_key", targetValue: "5", tier, enabled: true }
  it("accepts an API key owned by the tenant", async () => expect(await validateRatePolicyInput(value, 7)).toMatchObject(value))
  it("rejects a key from another tenant", async () => await expect(validateRatePolicyInput({ ...value, targetValue: "99" }, 7)).rejects.toThrow(/belong/))
  it("rejects non-API endpoints and invalid limits", async () => {
    await expect(validateRatePolicyInput({ ...value, targetType: "endpoint", targetValue: "https://evil.example" }, 7)).rejects.toThrow(/endpoint/i)
    await expect(validateRatePolicyInput({ ...value, tier: { ...tier, minute: 0 } }, 7)).rejects.toThrow(/minute/)
  })
})
