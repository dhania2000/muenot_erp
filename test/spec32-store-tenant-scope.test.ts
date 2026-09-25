import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn() }))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: m.query }))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLog: m.audit }))

import { applicableSteps } from "@/lib/onboarding/store"
import { createUpdate, listForViewer } from "@/lib/product-updates/store"

const input = { version: "2027.1.0", title: "Release", body: "Notes", category: "feature" as const, audienceType: "all" as const, audienceConfig: {} }
const row = { id: 11, version: "2027.1.0", title: "Release", body: "Notes", category: "feature", audience_type: "all", audience_config: "{}", status: "draft", published_at: null, created_by: 1, created_by_name: "a@t", created_at: "x", updated_at: "x" }

beforeEach(() => {
  m.query.mockReset()
  m.audit.mockReset()
})

describe("onboarding applicableSteps is tenant-specific", () => {
  it("reads only the requesting tenant's module overrides", async () => {
    m.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("SELECT slug FROM modules")) return [{ slug: "crm" }, { slug: "hr" }]
      if (sql.includes("FROM company_settings")) return []
      if (sql.includes("FROM tenant_settings")) return params[0] === 5 ? [{ skey: "module.crm", svalue: "0" }, { skey: "module.hr", svalue: "0" }] : []
      return []
    })
    expect(await applicableSteps(5)).not.toContain("modules")
    expect(await applicableSteps(6)).toContain("modules")
    const tenantCalls = m.query.mock.calls.filter(([sql]) => String(sql).includes("tenant_settings"))
    expect(tenantCalls.map(([, p]) => p)).toEqual([[5], [6]])
  })

  it("tolerates a missing modules table", async () => {
    m.query.mockRejectedValue(Object.assign(new Error("missing"), { code: "ER_NO_SUCH_TABLE" }))
    expect(await applicableSteps(1)).not.toContain("modules")
  })
})

describe("product update store", () => {
  const schemaOk = (sql: string) => {
    if (sql.includes("information_schema.columns")) return [{ c: 1 }]
    if (sql.includes("key_column_usage")) return [{ col: "tenant_id" }]
    return undefined
  }

  it("replays an existing draft for a repeated idempotency key without inserting", async () => {
    m.query.mockImplementation(async (sql: string) => schemaOk(sql) ?? (sql.includes("WHERE idempotency_key") ? [row] : []))
    const res = await createUpdate({ userId: 1, name: "a@t" }, input, undefined, { idempotencyKey: "key-12345678" })
    expect(res).toMatchObject({ replayed: true, update: { id: 11 } })
    expect(m.query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT"))).toBe(false)
    expect(m.audit).not.toHaveBeenCalled()
  })

  it("rejects a reused key carrying a different payload", async () => {
    m.query.mockImplementation(async (sql: string) => schemaOk(sql) ?? (sql.includes("WHERE idempotency_key") ? [row] : []))
    await expect(
      createUpdate({ userId: 1, name: "a@t" }, { ...input, title: "Other" }, undefined, { idempotencyKey: "key-12345678" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 })
  })

  it("scopes read state to the viewer's tenant", async () => {
    m.query.mockImplementation(async (sql: string) => schemaOk(sql) ?? [])
    await listForViewer({ tenantId: 42, role: "employee" }, 9)
    const read = m.query.mock.calls.find(([sql]) => String(sql).includes("LEFT JOIN product_update_reads"))
    expect(String(read?.[0])).toContain("r.tenant_id = ?")
    expect(read?.[1]).toEqual([42, 9])
  })
})
