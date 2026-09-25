import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Platform tenant-database API — permission, validation, cross-tenant and
 * failure behavior. The store, provisioning engine, tenant directory and audit
 * log are mocked so we exercise the ROUTE contract (authz, validation, status
 * mapping, idempotency plumbing) without a database. The pure model/regions
 * validators run for real.
 */

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  getTenantById: vi.fn(),
  updateTenant: vi.fn(),
  recordPlatformAudit: vi.fn(),
  // store
  ensureRegistryRow: vi.fn(),
  getRegionSettings: vi.fn(),
  getTenantDbRecord: vi.fn(),
  listTenantDbAudit: vi.fn(),
  saveRegionSettings: vi.fn(),
  saveRoutingSettings: vi.fn(),
  // provisioning
  provision: vi.fn(),
  migrate: vi.fn(),
  health: vi.fn(),
  backup: vi.fn(),
}))

vi.mock("@/lib/platform-guard", () => ({ requirePlatformSuperAdmin: mocks.guard }))
vi.mock("@/lib/tenant-service", () => ({ getTenantById: mocks.getTenantById, updateTenant: mocks.updateTenant }))
vi.mock("@/lib/platform-roles", () => ({ recordPlatformAudit: mocks.recordPlatformAudit }))
vi.mock("@/lib/tenant-db/store", () => ({
  ensureRegistryRow: mocks.ensureRegistryRow,
  getRegionSettings: mocks.getRegionSettings,
  getTenantDbRecord: mocks.getTenantDbRecord,
  listTenantDbAudit: mocks.listTenantDbAudit,
  saveRegionSettings: mocks.saveRegionSettings,
  saveRoutingSettings: mocks.saveRoutingSettings,
}))
vi.mock("@/lib/tenant-db/provisioning", () => ({
  provisionTenantDatabase: mocks.provision,
  migrateTenantDatabase: mocks.migrate,
  healthCheckTenantDatabase: mocks.health,
  backupTenantDatabase: mocks.backup,
}))

import { GET, PUT } from "@/app/api/platform/tenants/[id]/database/route"
import { POST } from "@/app/api/platform/tenants/[id]/database/[action]/route"

const AS_SUPER = { ok: true, ctx: { userId: 42 }, session: { userId: 42, email: "root@muenot.io", name: "Root" } }
const settingsCtx = { params: Promise.resolve({ id: "5" }) }
function actionCtx(action: string, id = "5") {
  return { params: Promise.resolve({ id, action }) }
}
function req(body?: unknown, headers?: Record<string, string>) {
  return new Request("http://localhost", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  }) as any
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getTenantById.mockResolvedValue({ id: 5, name: "Acme", slug: "acme", deployment_model: "shared_database", db_schema: null, db_connection_ref: null })
  mocks.getRegionSettings.mockResolvedValue({ dataRegion: "eu-west-1", dbRegion: "eu-west-1", storageRegion: null, backupRegion: null })
  mocks.getTenantDbRecord.mockResolvedValue({ tenantId: 5, deploymentModel: "shared_database", status: "unprovisioned" })
  mocks.ensureRegistryRow.mockResolvedValue({ tenantId: 5, deploymentModel: "shared_database", status: "unprovisioned" })
  mocks.listTenantDbAudit.mockResolvedValue([])
  mocks.saveRoutingSettings.mockResolvedValue({ tenantId: 5, deploymentModel: "separate_schema", status: "unprovisioned" })
})

describe("authorization", () => {
  it("blocks non super-admins from reading routing", async () => {
    mocks.guard.mockResolvedValue({ ok: false, status: 403, reason: "Platform privileges required" })
    const res = await GET(req() as any, settingsCtx)
    expect(res.status).toBe(403)
    expect(mocks.getTenantById).not.toHaveBeenCalled()
  })

  it("blocks non super-admins from mutating routing", async () => {
    mocks.guard.mockResolvedValue({ ok: false, status: 401, reason: "Not authenticated" })
    const res = await PUT(req({ routing: { deploymentModel: "separate_schema", schema: "acme" } }) as any, settingsCtx)
    expect(res.status).toBe(401)
    expect(mocks.saveRoutingSettings).not.toHaveBeenCalled()
  })

  it("blocks non super-admins from lifecycle actions", async () => {
    mocks.guard.mockResolvedValue({ ok: false, status: 403, reason: "Platform privileges required" })
    const res = await POST(req() as any, actionCtx("provision"))
    expect(res.status).toBe(403)
    expect(mocks.provision).not.toHaveBeenCalled()
  })
})

describe("input + cross-tenant validation", () => {
  beforeEach(() => mocks.guard.mockResolvedValue(AS_SUPER))

  it("rejects an invalid tenant id without loading anything", async () => {
    const res = await PUT(req({ routing: {} }) as any, { params: Promise.resolve({ id: "abc" }) })
    expect(res.status).toBe(400)
    expect(mocks.getTenantById).not.toHaveBeenCalled()
  })

  it("returns 404 for a tenant that does not exist", async () => {
    mocks.getTenantById.mockResolvedValue(null)
    const res = await PUT(req({ routing: { deploymentModel: "separate_schema", schema: "x" } }) as any, settingsCtx)
    expect(res.status).toBe(404)
    expect(mocks.saveRoutingSettings).not.toHaveBeenCalled()
  })

  it("rejects a separate_schema switch that supplies no schema", async () => {
    const res = await PUT(req({ routing: { deploymentModel: "separate_schema" } }) as any, settingsCtx)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.errors.some((e: any) => e.field === "schema")).toBe(true)
    expect(mocks.saveRoutingSettings).not.toHaveBeenCalled()
  })

  it("rejects a dedicated switch that supplies no connection ref", async () => {
    const res = await PUT(req({ routing: { deploymentModel: "dedicated_database", schema: "acme" } }) as any, settingsCtx)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.errors.some((e: any) => e.field === "connectionRef")).toBe(true)
  })

  it("rejects a db region that violates the tenant's residency anchor", async () => {
    const res = await PUT(req({ regions: { dataRegion: "eu-west-1", backupRegion: "us-east-1" } }) as any, settingsCtx)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.violations.some((v: any) => v.facet === "backup_region")).toBe(true)
    expect(mocks.saveRegionSettings).not.toHaveBeenCalled()
  })

  it("rejects an unknown action", async () => {
    const res = await POST(req() as any, actionCtx("nuke"))
    expect(res.status).toBe(400)
    expect(mocks.provision).not.toHaveBeenCalled()
  })
})

describe("successful mutations", () => {
  beforeEach(() => mocks.guard.mockResolvedValue(AS_SUPER))

  it("fails closed on an isolated-mode activation before writing regions or routing", async () => {
    const res = await PUT(
      req({ routing: { deploymentModel: "separate_schema", schema: "acme", dbRegion: "eu-central-1" } }) as any,
      settingsCtx,
    )
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("HOSTING_MODE_NOT_READY")
    expect(mocks.saveRoutingSettings).not.toHaveBeenCalled()
    expect(mocks.saveRegionSettings).not.toHaveBeenCalled()
    expect(mocks.updateTenant).not.toHaveBeenCalled()
  })

  it("blocks edits when a legacy routing registry is isolated even if the tenant directory says shared", async () => {
    mocks.getTenantDbRecord.mockResolvedValue({ tenantId: 5, deploymentModel: "dedicated_database" })
    const res = await PUT(req({ regions: { dataRegion: "eu-west-1", dbRegion: "eu-west-1" } }) as any, settingsCtx)
    expect(res.status).toBe(409)
    expect(mocks.saveRegionSettings).not.toHaveBeenCalled()
  })

  it("persists valid region settings", async () => {
    const res = await PUT(
      req({ regions: { dataRegion: "eu-west-1", dbRegion: "eu-central-1", storageRegion: "eu-west-1" } }) as any,
      settingsCtx,
    )
    expect(res.status).toBe(200)
    expect(mocks.saveRegionSettings).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ dataRegion: "eu-west-1", dbRegion: "eu-central-1", storageRegion: "eu-west-1" }),
    )
  })
})

describe("lifecycle actions map results to status + carry the idempotency key", () => {
  beforeEach(() => mocks.guard.mockResolvedValue(AS_SUPER))

  it("returns 200 and forwards the Idempotency-Key header to provisioning", async () => {
    mocks.provision.mockResolvedValue({ ok: true, action: "provision", status: "active", detail: "done", record: {}, deduplicated: false })
    const res = await POST(req({}, { "Idempotency-Key": "key-123" }) as any, actionCtx("provision"))
    expect(res.status).toBe(200)
    expect(mocks.provision).toHaveBeenCalledWith(5, { userId: 42, email: "root@muenot.io" }, "key-123")
    expect(mocks.recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "tenant_db_provision", targetTenantId: 5 }),
    )
  })

  it("maps a failed operation to 422 while still returning the detail", async () => {
    mocks.migrate.mockResolvedValue({ ok: false, action: "migrate", status: "failed", detail: "boom", record: {}, deduplicated: false })
    const res = await POST(req({}) as any, actionCtx("migrate"))
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.result.detail).toBe("boom")
  })

  it("surfaces an idempotent replay as a deduplicated success", async () => {
    mocks.backup.mockResolvedValue({ ok: true, action: "backup", status: "active", detail: "replay", record: {}, deduplicated: true })
    const res = await POST(req({ idempotencyKey: "b-1" }) as any, actionCtx("backup"))
    expect(res.status).toBe(200)
    expect(mocks.backup).toHaveBeenCalledWith(5, { userId: 42, email: "root@muenot.io" }, "b-1")
    const json = await res.json()
    expect(json.result.deduplicated).toBe(true)
  })

  it("runs the read-only health probe without requiring a key", async () => {
    mocks.health.mockResolvedValue({ ok: true, action: "health", status: "healthy", detail: "ok", record: {}, deduplicated: false })
    const res = await POST(req() as any, actionCtx("health"))
    expect(res.status).toBe(200)
    expect(mocks.health).toHaveBeenCalledWith(5)
  })
})
