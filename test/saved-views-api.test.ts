import { beforeEach, describe, expect, it, vi } from "vitest"

type Row = Record<string, any>

const mock = vi.hoisted(() => {
  const state = { rows: [] as Row[], nextId: 1, failInsert: null as Error | null, hideIdempotencyOnce: false }
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim()
    if (s.includes("information_schema")) return [{ c: 1 }]
    if (s.startsWith("CREATE TABLE") || s.startsWith("ALTER TABLE")) return []
    if (s.includes("hr_employees")) return []
    if (s.startsWith("SELECT id FROM `saved_views` WHERE tenant_id = ? AND created_by = ? AND idempotency_key")) {
      if (state.hideIdempotencyOnce) {
        state.hideIdempotencyOnce = false
        return []
      }
      const [t, u, k] = params
      return state.rows.filter((r) => r.tenant_id === t && r.created_by === u && r.idempotency_key === k).map((r) => ({ id: r.id }))
    }
    if (s.startsWith("SELECT * FROM `saved_views` WHERE id = ? AND tenant_id = ?")) {
      const [id, t] = params
      return state.rows.filter((r) => r.id === id && r.tenant_id === t)
    }
    if (s.startsWith("SELECT * FROM `saved_views` WHERE tenant_id = ? AND table_key = ?")) {
      const [t, table, userId] = params
      return state.rows.filter(
        (r) =>
          r.tenant_id === t &&
          r.table_key === table &&
          (r.visibility === "public" || (r.visibility === "private" && r.owner_user_id === userId)),
      )
    }
    if (s.startsWith("INSERT INTO `saved_views`")) {
      if (state.failInsert) throw state.failInsert
      const [tenant_id, table_key, name, visibility, owner_user_id, role_key, team_key, config, is_default, created_by, idempotency_key] = params
      const id = state.nextId++
      state.rows.push({ id, tenant_id, table_key, name, visibility, owner_user_id, role_key, team_key, config, is_default, created_by, idempotency_key })
      return { insertId: id }
    }
    if (s.startsWith("UPDATE `saved_views` SET is_default = 0")) {
      const [t, table] = params
      const except = s.includes("id <> ?") ? params[params.length - 1] : null
      for (const r of state.rows) if (r.tenant_id === t && r.table_key === table && r.id !== except) r.is_default = 0
      return {}
    }
    if (s.startsWith("UPDATE `saved_views` SET name = ?")) {
      const [name, visibility, owner_user_id, role_key, team_key, config, is_default, id, t] = params
      const r = state.rows.find((x) => x.id === id && x.tenant_id === t)
      if (r) Object.assign(r, { name, visibility, owner_user_id, role_key, team_key, config, is_default })
      return {}
    }
    if (s.startsWith("DELETE FROM `saved_views`")) {
      const [id, t] = params
      state.rows = state.rows.filter((r) => !(r.id === id && r.tenant_id === t))
      return {}
    }
    throw new Error(`Unexpected SQL in test: ${s.slice(0, 80)}`)
  })
  return {
    state,
    query,
    session: vi.fn(),
    hasFeature: vi.fn(),
    audit: vi.fn(async () => {}),
  }
})

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mock.query }))
vi.mock("@/lib/auth", () => ({ getSession: mock.session }))
vi.mock("@/lib/permissions", () => ({ userHasFeature: mock.hasFeature }))
vi.mock("@/lib/audit-log-store", () => ({
  captureAuditContext: vi.fn(async () => ({})),
  recordAuditLog: mock.audit,
}))

import { GET, POST } from "@/app/api/saved-views/route"
import { DELETE, PUT } from "@/app/api/saved-views/[id]/route"

const TENANT_A = { userId: 10, tenantId: 1, role: "employee" }
const TENANT_B = { userId: 20, tenantId: 2, role: "employee" }
const ADMIN_A = { userId: 11, tenantId: 1, role: "admin" }

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://test/api/saved-views", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  )
}
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })
const put = (id: number, body: unknown) =>
  PUT(new Request(`http://test/api/saved-views/${id}`, { method: "PUT", body: JSON.stringify(body) }), ctx(id))
const del = (id: number | string) => DELETE(new Request(`http://test/api/saved-views/${id}`, { method: "DELETE" }), ctx(id))

beforeEach(() => {
  vi.clearAllMocks()
  mock.state.rows = []
  mock.state.nextId = 1
  mock.state.failInsert = null
  mock.state.hideIdempotencyOnce = false
  mock.session.mockResolvedValue(TENANT_A)
  mock.hasFeature.mockResolvedValue(true)
})

describe("saved views API — auth and permissions", () => {
  it("rejects anonymous requests", async () => {
    mock.session.mockResolvedValue(null)
    expect((await GET(new Request("http://test/api/saved-views?table=clients"))).status).toBe(401)
    expect((await post({ tableKey: "clients", name: "x" })).status).toBe(401)
  })

  it("rejects a session without a tenant instead of using a shared bucket", async () => {
    mock.session.mockResolvedValue({ userId: 1, tenantId: null, role: "employee" })
    expect((await GET(new Request("http://test/api/saved-views?table=clients"))).status).toBe(403)
  })

  it("requires the feature that gates the underlying table", async () => {
    mock.hasFeature.mockResolvedValue(false)
    expect((await GET(new Request("http://test/api/saved-views?table=clients"))).status).toBe(403)
    expect((await post({ tableKey: "clients", name: "Mine" })).status).toBe(403)
    expect(mock.hasFeature).toHaveBeenCalledWith(10, "employee", "clients.view_clients")
  })

  it("forbids non-admins from creating public views", async () => {
    const res = await post({ tableKey: "clients", name: "Everyone", visibility: "public" })
    expect(res.status).toBe(403)
    expect(mock.state.rows).toHaveLength(0)
  })

  it("only allows personal views on unregistered tables", async () => {
    expect((await post({ tableKey: "custom.table", name: "Mine" })).status).toBe(201)
    mock.session.mockResolvedValue(ADMIN_A)
    expect((await post({ tableKey: "custom.table", name: "All", visibility: "public" })).status).toBe(403)
  })
})

describe("saved views API — validation", () => {
  it.each([
    [{ tableKey: "clients", name: "" }, "empty name"],
    [{ tableKey: "clients", name: "x".repeat(161) }, "name too long"],
    [{ tableKey: "DROP TABLE", name: "x" }, "malformed table key"],
    [{ tableKey: "clients", name: "x", visibility: "world" }, "unknown visibility"],
  ])("returns 400 for %j (%s)", async (body) => {
    expect((await post(body)).status).toBe(400)
  })

  it("rejects malformed idempotency keys", async () => {
    expect((await post({ tableKey: "clients", name: "x" }, { "idempotency-key": "bad key!" })).status).toBe(400)
  })

  it("clamps column widths and drops unknown fields before storing", async () => {
    await post({
      tableKey: "clients",
      name: "Wide",
      config: { columns: [{ key: "client", width: 99999, pinned: true, evil: "<script>" }, { key: "client" }], groupBy: "status" },
    })
    const stored = JSON.parse(mock.state.rows[0].config)
    expect(stored.columns).toEqual([{ key: "client", hidden: false, width: 800, pinned: true }])
    expect(stored.groupBy).toBe("status")
  })

  it("rejects ids that are not positive integers", async () => {
    expect((await del("abc")).status).toBe(400)
    expect((await del("-3")).status).toBe(400)
  })
})

describe("saved views API — idempotency and audit", () => {
  it("replays a retried create without a duplicate row or audit entry", async () => {
    const headers = { "idempotency-key": "create-view-0001" }
    const first = await post({ tableKey: "clients", name: "Active" }, headers)
    const second = await post({ tableKey: "clients", name: "Active" }, headers)
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ id: 1, replayed: true })
    expect(mock.state.rows).toHaveLength(1)
    expect(mock.audit).toHaveBeenCalledTimes(1)
    expect(mock.audit.mock.calls[0][0]).toMatchObject({ action: "saved_view.create", entityId: 1 })
  })

  it("scopes idempotency keys per tenant", async () => {
    const headers = { "idempotency-key": "shared-key-0001" }
    await post({ tableKey: "clients", name: "A" }, headers)
    mock.session.mockResolvedValue(TENANT_B)
    const res = await post({ tableKey: "clients", name: "B" }, headers)
    expect(res.status).toBe(201)
    expect(mock.state.rows.map((r) => r.tenant_id)).toEqual([1, 2])
  })

  it("resolves a concurrent duplicate insert to the winning row", async () => {
    await post({ tableKey: "clients", name: "Race" }, { "idempotency-key": "race-key-0001" })
    // Simulate the race: the pre-check misses, then the unique index fires.
    mock.state.failInsert = Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" })
    mock.state.hideIdempotencyOnce = true
    const res = await post({ tableKey: "clients", name: "Race" }, { "idempotency-key": "race-key-0001" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 1, replayed: true })
  })

  it("audits update and delete with before snapshots", async () => {
    await post({ tableKey: "clients", name: "Old" })
    expect((await put(1, { tableKey: "clients", name: "New" })).status).toBe(200)
    expect((await del(1)).status).toBe(200)
    const actions = mock.audit.mock.calls.map((c) => c[0])
    expect(actions[1]).toMatchObject({ action: "saved_view.update", before: { name: "Old" }, after: { name: "New" } })
    expect(actions[2]).toMatchObject({ action: "saved_view.delete", before: { name: "New", tableKey: "clients" } })
  })

  it("returns a generic 500 without leaking database errors", async () => {
    mock.state.failInsert = new Error("ECONNREFUSED 10.0.0.5:3306")
    vi.spyOn(console, "log").mockImplementation(() => {})
    const res = await post({ tableKey: "clients", name: "x" })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Failed to create view" })
    expect(mock.audit).not.toHaveBeenCalled()
  })
})

describe("saved views API — cross-tenant isolation", () => {
  beforeEach(async () => {
    mock.session.mockResolvedValue(ADMIN_A)
    await post({ tableKey: "clients", name: "Tenant A public", visibility: "public" })
    mock.audit.mockClear()
    mock.session.mockResolvedValue(TENANT_B)
  })

  it("never lists another tenant's views", async () => {
    const res = await GET(new Request("http://test/api/saved-views?table=clients"))
    expect((await res.json()).views).toEqual([])
  })

  it("returns 404 (not 403) when updating or deleting another tenant's view", async () => {
    expect((await put(1, { tableKey: "clients", name: "Hijack" })).status).toBe(404)
    expect((await del(1)).status).toBe(404)
    expect(mock.state.rows[0]).toMatchObject({ name: "Tenant A public", tenant_id: 1 })
    expect(mock.audit).not.toHaveBeenCalled()
  })

  it("stamps new views with the session tenant, ignoring any tenantId in the body", async () => {
    await post({ tableKey: "clients", name: "Mine", tenantId: 1 })
    expect(mock.state.rows[1].tenant_id).toBe(2)
  })
})

describe("saved views API — ownership and table binding", () => {
  it("prevents another user in the same tenant from editing a private view", async () => {
    await post({ tableKey: "clients", name: "Private" })
    mock.session.mockResolvedValue({ ...TENANT_A, userId: 99 })
    expect((await put(1, { tableKey: "clients", name: "Mine now" })).status).toBe(403)
    expect((await del(1)).status).toBe(403)
  })

  it("refuses to move a view to a table the caller used only for authorization", async () => {
    await post({ tableKey: "sales.deals", name: "Deals" })
    expect((await put(1, { tableKey: "clients", name: "Deals" })).status).toBe(400)
    expect(mock.state.rows[0].table_key).toBe("sales.deals")
  })

  it("revokes deleting a view once access to its table is lost", async () => {
    await post({ tableKey: "sales.deals", name: "Deals" })
    mock.hasFeature.mockImplementation(async (_u: number, _r: string, f: string) => f !== "sales.view_deals")
    expect((await del(1)).status).toBe(403)
    expect(mock.state.rows).toHaveLength(1)
  })

  it("keeps a single default per audience", async () => {
    await post({ tableKey: "clients", name: "One", isDefault: true })
    await post({ tableKey: "clients", name: "Two", isDefault: true })
    expect(mock.state.rows.map((r) => r.is_default)).toEqual([0, 1])
  })
})
