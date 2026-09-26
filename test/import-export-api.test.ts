import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => {
  class BatchImportNotFoundError extends Error {}
  class BatchImportStateError extends Error {}
  class ExportIdempotencyConflictError extends Error {}
  return {
    BatchImportNotFoundError,
    BatchImportStateError,
    ExportIdempotencyConflictError,
    tenantAdmin: vi.fn(),
    tenantOwner: vi.fn(),
    rollback: vi.fn(),
    resume: vi.fn(),
    createExport: vi.fn(),
    withLink: vi.fn(),
  }
})

vi.mock("@/lib/platform-guard", () => ({
  requireTenantAdmin: m.tenantAdmin,
  requireTenantOwner: m.tenantOwner,
  effectiveTenantId: (ctx: { tenantId: number }) => ctx.tenantId,
}))
vi.mock("@/lib/data-import-batches-store", () => ({
  BatchImportNotFoundError: m.BatchImportNotFoundError,
  BatchImportStateError: m.BatchImportStateError,
  rollbackBatchImport: m.rollback,
  resumeBatchImport: m.resume,
}))
vi.mock("@/lib/data-export-store", () => ({
  ExportIdempotencyConflictError: m.ExportIdempotencyConflictError,
  createAndRunExport: m.createExport,
  getExportJobWithLink: m.withLink,
  listExportJobs: vi.fn(async () => []),
  listExportSchedules: vi.fn(async () => []),
}))
vi.mock("@/lib/data-export-catalog", () => ({ exportCatalogForClient: () => [] }))

import * as rollbackRoute from "@/app/api/admin/governance/data-import/batches/[id]/rollback/route"
import * as resumeRoute from "@/app/api/admin/governance/data-import/batches/[id]/resume/route"
import * as exportRoute from "@/app/api/admin/governance/export/route"

const ok = (tenantId: number, tenantRole = "admin") => ({
  ok: true,
  ctx: { tenantId, tenantRole },
  session: { userId: 11, name: "A", email: "a@x.test" },
})
const denied = { ok: false, status: 403, reason: "Forbidden" }
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (url: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  m.tenantAdmin.mockResolvedValue(ok(7))
  m.tenantOwner.mockResolvedValue(ok(7, "owner"))
})

describe("batch import routes", () => {
  it("refuses non-admins before touching the store", async () => {
    m.tenantAdmin.mockResolvedValue(denied)
    const res = await rollbackRoute.POST(post("http://t/x"), params("5"))
    expect(res.status).toBe(403)
    expect(m.rollback).not.toHaveBeenCalled()
  })

  it("rejects malformed job ids", async () => {
    for (const id of ["0", "-1", "1e3", "abc", "1;DROP"]) {
      const res = await rollbackRoute.POST(post("http://t/x"), params(id))
      expect(res.status).toBe(400)
    }
    expect(m.rollback).not.toHaveBeenCalled()
  })

  it("scopes to the session tenant, ignoring any tenant in the body", async () => {
    m.rollback.mockResolvedValue({ id: 5 })
    await rollbackRoute.POST(post("http://t/x", { tenantId: 99 }), params("5"))
    expect(m.rollback).toHaveBeenCalledWith(7, expect.objectContaining({ userId: 11 }), 5)
  })

  it("returns 404 (not 403) for another tenant's job so ids are not enumerable", async () => {
    m.rollback.mockRejectedValue(new m.BatchImportNotFoundError("nope"))
    const res = await rollbackRoute.POST(post("http://t/x"), params("5"))
    expect(res.status).toBe(404)
  })

  it("maps illegal transitions to 409 and hides internal errors", async () => {
    m.rollback.mockRejectedValueOnce(new m.BatchImportStateError("running"))
    expect((await rollbackRoute.POST(post("http://t/x"), params("5"))).status).toBe(409)
    m.rollback.mockRejectedValueOnce(new Error("ER_ACCESS_DENIED secret host"))
    const res = await rollbackRoute.POST(post("http://t/x"), params("5"))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/secret/)
  })

  it("resume forwards the idempotency key and the session tenant", async () => {
    m.resume.mockResolvedValue({ id: 5 })
    const res = await resumeRoute.POST(post("http://t/x", {}, { "Idempotency-Key": "resume-key-0001" }), params("5"))
    expect(res.status).toBeLessThan(300)
    expect(m.resume.mock.calls[0][0]).toBe(7)
    expect(JSON.stringify(m.resume.mock.calls[0])).toContain("resume-key-0001")
  })
})

describe("export route", () => {
  it("requires tenant-owner for a full backup package", async () => {
    m.tenantOwner.mockResolvedValue(denied)
    const res = await exportRoute.POST(post("http://t/e", { datasetKey: "__full_tenant__", format: "backup" }))
    expect(res.status).toBe(403)
    expect(m.tenantAdmin).not.toHaveBeenCalled()
    expect(m.createExport).not.toHaveBeenCalled()
  })

  it("rejects unknown formats", async () => {
    const res = await exportRoute.POST(post("http://t/e", { datasetKey: "crm-leads", format: "exe" }))
    expect(res.status).toBe(400)
  })

  it("rejects a malformed Idempotency-Key", async () => {
    const res = await exportRoute.POST(post("http://t/e", { datasetKey: "crm-leads", format: "csv" }, { "Idempotency-Key": "x" }))
    expect(res.status).toBe(400)
    expect(m.createExport).not.toHaveBeenCalled()
  })

  it("passes the key through and 409s on a reused key with different params", async () => {
    m.createExport.mockRejectedValue(new m.ExportIdempotencyConflictError("reused"))
    const res = await exportRoute.POST(
      post("http://t/e", { datasetKey: "crm-leads", format: "csv" }, { "Idempotency-Key": "export-key-0001" }),
    )
    expect(res.status).toBe(409)
    expect(m.createExport).toHaveBeenCalledWith(7, expect.objectContaining({ idempotencyKey: "export-key-0001" }), expect.anything())
  })
})
