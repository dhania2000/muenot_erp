import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getTenantById: vi.fn(),
  getRegionSettings: vi.fn(),
  ensureRegistryRow: vi.fn(),
  recordTenantDbAudit: vi.fn(),
  isDuplicateAction: vi.fn(),
  setProvisionStatus: vi.fn(),
  getTenantDbRecord: vi.fn(),
  createPool: vi.fn(),
}))

vi.mock("@/lib/tenant-service", () => ({ getTenantById: mocks.getTenantById }))
vi.mock("@/lib/tenant-db/store", () => ({
  getRegionSettings: mocks.getRegionSettings,
  ensureRegistryRow: mocks.ensureRegistryRow,
  recordTenantDbAudit: mocks.recordTenantDbAudit,
  isDuplicateAction: mocks.isDuplicateAction,
  setProvisionStatus: mocks.setProvisionStatus,
  getTenantDbRecord: mocks.getTenantDbRecord,
}))
vi.mock("@/lib/tenant-db/router", () => ({ getPoolForProfile: vi.fn() }))
vi.mock("mysql2/promise", () => ({ default: { createPool: mocks.createPool } }))

import { backupTenantDatabase, migrateTenantDatabase, provisionTenantDatabase } from "@/lib/tenant-db/provisioning"

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getTenantById.mockResolvedValue({
    id: 77, deployment_model: "dedicated_database", db_schema: "tenant_77",
    db_connection_ref: "TENANT_77_DSN",
  })
  mocks.getRegionSettings.mockResolvedValue({ dataRegion: null, dbRegion: null })
  mocks.ensureRegistryRow.mockResolvedValue({
    tenantId: 77, deploymentModel: "dedicated_database", schema: "tenant_77",
    connectionRef: "TENANT_77_DSN", status: "active",
  })
  mocks.isDuplicateAction.mockResolvedValue(false)
  mocks.getTenantDbRecord.mockResolvedValue({ tenantId: 77, deploymentModel: "dedicated_database", status: "provisioning" })
  mocks.createPool.mockReturnValue({ query: vi.fn().mockResolvedValue([[], []]), end: vi.fn().mockResolvedValue(undefined) })
})

describe("tenant backup safety", () => {
  it("never reports a row-count manifest as a restorable backup", async () => {
    const result = await backupTenantDatabase(77, { userId: 1 }, "retry-key")
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe("BACKUP_UNAVAILABLE")
    expect(result.manifestRef).toBeUndefined()
    expect(mocks.recordTenantDbAudit).not.toHaveBeenCalled()
  })

  it("does not mark a marker-only database as schema-migrated", async () => {
    const result = await migrateTenantDatabase(77, { userId: 1 }, "retry-key")
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe("SCHEMA_MIGRATIONS_UNAVAILABLE")
    expect(mocks.recordTenantDbAudit).not.toHaveBeenCalled()
  })

  it("does not mark an empty created schema as active", async () => {
    process.env.TENANT_77_DSN = "mysql://runtime:password@db.example.com/tenant_77"
    try {
      const result = await provisionTenantDatabase(77, { userId: 1 }, "create-once")
      expect(result.ok).toBe(true)
      expect(result.status).toBe("provisioning")
      expect(mocks.setProvisionStatus).not.toHaveBeenCalledWith(77, "active", null)
      expect(mocks.recordTenantDbAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "provision", detail: expect.objectContaining({ status: "provisioning" }) }),
      )
    } finally {
      delete process.env.TENANT_77_DSN
    }
  })
})
