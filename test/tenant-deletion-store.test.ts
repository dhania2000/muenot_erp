import { beforeEach, describe, expect, it, vi } from "vitest"
import { MiniSql } from "./helpers/mini-sql"

/**
 * Spec24 — tenant deletion store (#153, #156). Runs the store's real SQL against
 * the in-memory engine while mocking the legal-hold and export dependencies, to
 * prove the four safeguards are enforced server-side: request idempotency
 * (single active request), the mandatory export, the retention/backup proof and
 * the legal-hold block, plus the full cooling → export → prove → approve →
 * execute happy path, cancellation, and audit evidence at every step.
 */

const db = new MiniSql()
const audit = vi.hoisted(() => ({ recordAuditLog: vi.fn(async () => {}) }))
const deps = vi.hoisted(() => ({
  listHolds: vi.fn(async () => [] as any[]),
  createAndRunExport: vi.fn(async () => ({ id: 555, status: "completed", rowCount: 42 })),
}))

vi.mock("@/lib/db", () => ({
  query: (sql: string, params?: any[]) => db.query(sql, params),
}))
vi.mock("@/lib/audit-log-store", () => audit)
vi.mock("@/lib/legal-hold-store", () => ({ listHolds: () => deps.listHolds() }))
vi.mock("@/lib/data-export-store", () => ({ createAndRunExport: (...a: any[]) => deps.createAndRunExport(...a) }))
vi.mock("@/lib/data-export-model", () => ({ FULL_TENANT_EXPORT_KEY: "__full_tenant__" }))

import {
  approveTenantDeletion,
  assessDeletionReadiness,
  cancelTenantDeletion,
  executeTenantDeletion,
  getActiveDeletionRequest,
  getDeletionRequest,
  proveRetention,
  requestTenantDeletion,
  runDeletionExport,
} from "@/lib/tenant-deletion-store"

const actor = { userId: 1, name: "Owner", email: "owner@t.test", role: "owner" }
const TENANT_A = 10
const TENANT_B = 20

// Advance a request all the way to "ready to approve": export done, retention
// proven, cooling window forced into the past via direct row mutation.
async function makeReady(tenantId: number) {
  const req = await requestTenantDeletion(tenantId, { reason: "closing", coolingDays: 7 }, actor)
  await runDeletionExport(tenantId, req.id, actor)
  await proveRetention(tenantId, req.id, { proven: true, note: "backups verified" }, actor)
  // Force cooling elapsed.
  for (const row of db.rows("tenant_deletion_requests")) {
    if (row.id === req.id) row.cooling_ends_at = new Date(Date.now() - 86_400_000)
  }
  return req.id
}

beforeEach(() => {
  db.reset()
  audit.recordAuditLog.mockClear()
  deps.listHolds.mockReset()
  deps.listHolds.mockResolvedValue([])
  deps.createAndRunExport.mockReset()
  deps.createAndRunExport.mockResolvedValue({ id: 555, status: "completed", rowCount: 42 })
})

describe("requesting deletion", () => {
  it("opens a request, starts the cooling window and audits it", async () => {
    const req = await requestTenantDeletion(TENANT_A, { reason: "closing shop", coolingDays: 30 }, actor)
    expect(req.status).toBe("requested")
    expect(req.coolingDaysRemaining).toBeGreaterThan(0)
    expect(audit.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "privacy.tenant_deletion.requested" }),
      undefined,
    )
  })

  it("is idempotent — a second request returns the existing active one", async () => {
    const first = await requestTenantDeletion(TENANT_B, { coolingDays: 7 }, actor)
    const second = await requestTenantDeletion(TENANT_B, { coolingDays: 30 }, actor)
    expect(second.id).toBe(first.id)
    expect(await getActiveDeletionRequest(TENANT_B)).toMatchObject({ id: first.id })
  })
})

describe("mandatory export", () => {
  it("runs the full-tenant export and advances to export_ready", async () => {
    const req = await requestTenantDeletion(TENANT_A, { coolingDays: 7 }, actor)
    const after = await runDeletionExport(TENANT_A, req.id, actor)
    expect(after.status).toBe("export_ready")
    expect(after.exportCompleted).toBe(true)
    expect(deps.createAndRunExport).toHaveBeenCalled()
  })

  it("fails when the export does not complete", async () => {
    deps.createAndRunExport.mockResolvedValue({ id: 1, status: "failed", rowCount: 0 })
    const req = await requestTenantDeletion(TENANT_A, { coolingDays: 7 }, actor)
    await expect(runDeletionExport(TENANT_A, req.id, actor)).rejects.toThrow(/did not complete/i)
  })
})

describe("approval gate — four obligations", () => {
  it("blocks approval until cooling elapses, export completes and retention is proven", async () => {
    const req = await requestTenantDeletion(TENANT_A, { coolingDays: 30 }, actor)
    await expect(approveTenantDeletion(TENANT_A, req.id, actor)).rejects.toThrow(/Cannot approve/i)
    const readiness = await assessDeletionReadiness((await getDeletionRequest(TENANT_A, req.id))!)
    expect(readiness.canApprove).toBe(false)
    expect(readiness.checks.exportCompleted).toBe(false)
  })

  it("an active legal hold blocks approval absolutely, even when all else is ready", async () => {
    const id = await makeReady(TENANT_A)
    deps.listHolds.mockResolvedValue([{ status: "active" }])
    await expect(approveTenantDeletion(TENANT_A, id, actor)).rejects.toThrow(/active legal hold/i)
  })

  it("approves and then executes once every obligation is satisfied", async () => {
    const id = await makeReady(TENANT_A)
    const approved = await approveTenantDeletion(TENANT_A, id, actor)
    expect(approved.status).toBe("approved")
    const executed = await executeTenantDeletion(TENANT_A, id, actor)
    expect(executed.status).toBe("executed")
    expect(audit.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "privacy.tenant_deletion.approved" }),
      undefined,
    )
    expect(audit.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "privacy.tenant_deletion.executed" }),
      undefined,
    )
  })

  it("cannot execute a request that has not been approved", async () => {
    const id = await makeReady(TENANT_A)
    await expect(executeTenantDeletion(TENANT_A, id, actor)).rejects.toThrow(/Cannot execute/i)
  })
})

describe("cancellation and isolation", () => {
  it("cancels an open request before execution", async () => {
    const req = await requestTenantDeletion(TENANT_A, { coolingDays: 7 }, actor)
    const cancelled = await cancelTenantDeletion(TENANT_A, req.id, actor, "changed our mind")
    expect(cancelled.status).toBe("cancelled")
    expect(await getActiveDeletionRequest(TENANT_A)).toBeNull()
  })

  it("a request is not readable from another tenant", async () => {
    const req = await requestTenantDeletion(TENANT_A, { coolingDays: 7 }, actor)
    expect(await getDeletionRequest(TENANT_B, req.id)).toBeNull()
  })
})
