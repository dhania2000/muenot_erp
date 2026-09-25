import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ query: vi.fn(), conn: vi.fn() }))
vi.mock("@/lib/db", () => ({
  query: db.query,
  withTransaction: async (fn: (c: unknown) => unknown) => fn({ query: db.conn }),
}))

import { recordUsageEvents, setUserOptOut, updateSettings } from "@/lib/customer-success/store"
import { normalizeEvent } from "@/lib/customer-success/model"

const now = new Date()
const ev = (extra: Record<string, unknown> = {}) => normalizeEvent({ module: "sales", feature: "leads", ...extra }, now)

let settingsRow: Record<string, unknown> | null
let userOptedOut: boolean
const storedKeys = new Set<string>()

beforeEach(() => {
  vi.resetAllMocks()
  process.env.ANALYTICS_HASH_SECRET = "test-secret"
  settingsRow = null
  userOptedOut = false
  storedKeys.clear()
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM cs_tenant_settings")) return settingsRow ? [settingsRow] : []
    if (sql.includes("FROM cs_user_opt_outs")) return userOptedOut ? [{ x: 1 }] : []
    if (sql.startsWith("DELETE")) return { affectedRows: 4 }
    if (sql.includes("INSERT INTO cs_user_opt_outs")) return { affectedRows: userOptedOut ? 0 : 1 }
    return { affectedRows: 1 }
  })
  db.conn.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("INSERT INTO cs_usage_events")) {
      const key = String(params[5])
      if (storedKeys.has(key)) return [{ affectedRows: 0 }]
      storedKeys.add(key)
      return [{ affectedRows: 1 }]
    }
    return [{ affectedRows: 1 }]
  })
})

describe("recordUsageEvents deduplication", () => {
  it("collapses in-batch and cross-request duplicates; only new events increment the rollup", async () => {
    const first = await recordUsageEvents({ tenantId: 1, userId: 5, events: [ev(), ev(), ev({ feature: "deals" })] })
    expect(first).toEqual({ accepted: 2, duplicates: 1, dropped: 0, reason: null })
    const retry = await recordUsageEvents({ tenantId: 1, userId: 5, events: [ev(), ev({ feature: "deals" })] })
    expect(retry).toEqual({ accepted: 0, duplicates: 2, dropped: 0, reason: null })
    const rollups = db.conn.mock.calls.filter(([sql]) => String(sql).includes("cs_usage_daily"))
    expect(rollups).toHaveLength(2)
  })
  it("stores a pseudonymous actor and the session tenant, never the raw user id", async () => {
    await recordUsageEvents({ tenantId: 3, userId: 42, events: [ev()] })
    const [, params] = db.conn.mock.calls.find(([sql]) => String(sql).includes("cs_usage_events"))!
    expect(params[0]).toBe(3)
    expect(params[1]).toMatch(/^[a-f0-9]{32}$/)
    expect(params).not.toContain(42)
  })
  it("drops everything when the tenant opted out", async () => {
    settingsRow = { analytics_opt_out: 1, retention_days: 180 }
    expect(await recordUsageEvents({ tenantId: 1, userId: 5, events: [ev(), ev()] })).toEqual({ accepted: 0, duplicates: 0, dropped: 2, reason: "tenant_opt_out" })
    expect(db.conn).not.toHaveBeenCalled()
  })
  it("drops everything when the user opted out", async () => {
    userOptedOut = true
    expect(await recordUsageEvents({ tenantId: 1, userId: 5, events: [ev()] })).toMatchObject({ accepted: 0, reason: "user_opt_out" })
    expect(db.conn).not.toHaveBeenCalled()
  })
  it("fails closed without a hashing secret", async () => {
    delete process.env.ANALYTICS_HASH_SECRET
    const prev = process.env.SESSION_SECRET
    delete process.env.SESSION_SECRET
    await expect(recordUsageEvents({ tenantId: 1, userId: 5, events: [ev()] })).rejects.toThrow(/not configured/)
    if (prev) process.env.SESSION_SECRET = prev
  })
})

describe("opt-out controls", () => {
  it("tenant opt-out purges only that tenant's raw events and is idempotent", async () => {
    const r = await updateSettings(7, { analyticsOptOut: true }, 1)
    expect(r).toMatchObject({ changed: true, purgedEvents: 4 })
    const del = db.query.mock.calls.find(([sql]) => String(sql).startsWith("DELETE FROM cs_usage_events"))!
    expect(del[1]).toEqual([7])
    settingsRow = { analytics_opt_out: 1, retention_days: 180 }
    db.query.mockClear()
    expect(await updateSettings(7, { analyticsOptOut: true }, 1)).toMatchObject({ changed: false, purgedEvents: 0 })
    expect(db.query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT") || String(sql).startsWith("DELETE"))).toBe(false)
  })
  it("shortening retention purges immediately", async () => {
    const r = await updateSettings(7, { retentionDays: 30 }, 1)
    expect(r.changed).toBe(true)
    expect(r.purgedEvents).toBe(4)
  })
  it("user opt-out erases the user's events once; repeat is a no-op", async () => {
    expect(await setUserOptOut(2, 9, true)).toEqual({ changed: true, purgedEvents: 4 })
    userOptedOut = true
    expect(await setUserOptOut(2, 9, true)).toEqual({ changed: false, purgedEvents: 0 })
  })
})
