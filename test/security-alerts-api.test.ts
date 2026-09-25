import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * API surface for the Spec22 security-alerts triage endpoint. Verifies
 * permission gating (admin-only + tenant context required), input validation,
 * and that reads/writes are always scoped to the caller's tenant (the store is
 * invoked with the session tenant, never a client-supplied one).
 */
const mock = vi.hoisted(() => ({
  getSession: vi.fn(),
  getCurrentTenant: vi.fn(),
  listSecurityAlerts: vi.fn(),
  getSecurityAlertSummary: vi.fn(),
  updateAlertStatus: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ getSession: mock.getSession }))
vi.mock("@/lib/tenant-context", () => ({ getCurrentTenant: mock.getCurrentTenant }))
vi.mock("@/lib/security-alerts-store", () => ({
  listSecurityAlerts: mock.listSecurityAlerts,
  getSecurityAlertSummary: mock.getSecurityAlertSummary,
  updateAlertStatus: mock.updateAlertStatus,
}))

import { GET, POST } from "@/app/api/admin/security/alerts/route"

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/admin/security/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mock.getSession.mockResolvedValue({ userId: 5, role: "admin" })
  mock.getCurrentTenant.mockReturnValue({ tenantId: 7 })
  mock.listSecurityAlerts.mockResolvedValue([])
  mock.getSecurityAlertSummary.mockResolvedValue({ open: 0, critical: 0, acknowledged: 0 })
  mock.updateAlertStatus.mockResolvedValue(true)
})

describe("security-alerts API permissions", () => {
  it("rejects an unauthenticated request", async () => {
    mock.getSession.mockResolvedValue(null)
    const res = await GET(new Request("http://localhost/api/admin/security/alerts"))
    expect(res.status).toBe(403)
    expect(mock.listSecurityAlerts).not.toHaveBeenCalled()
  })

  it("rejects a non-admin (employee) request", async () => {
    mock.getSession.mockResolvedValue({ userId: 5, role: "employee" })
    const res = await GET(new Request("http://localhost/api/admin/security/alerts"))
    expect(res.status).toBe(403)
    expect(mock.listSecurityAlerts).not.toHaveBeenCalled()
  })

  it("rejects when no tenant context is established", async () => {
    mock.getCurrentTenant.mockReturnValue(null)
    const res = await GET(new Request("http://localhost/api/admin/security/alerts"))
    expect(res.status).toBe(403)
  })
})

describe("security-alerts API reads (tenant-scoped)", () => {
  it("lists alerts scoped to the session tenant with a valid filter", async () => {
    const res = await GET(new Request("http://localhost/api/admin/security/alerts?status=open&type=new_admin"))
    expect(res.status).toBe(200)
    expect(mock.listSecurityAlerts).toHaveBeenCalledWith(7, { status: "open", type: "new_admin" })
    expect(mock.getSecurityAlertSummary).toHaveBeenCalledWith(7)
  })

  it("ignores unknown status/type filter values", async () => {
    await GET(new Request("http://localhost/api/admin/security/alerts?status=bogus&type=evil"))
    expect(mock.listSecurityAlerts).toHaveBeenCalledWith(7, { status: undefined, type: undefined })
  })
})

describe("security-alerts API triage (validation + scoping)", () => {
  it("rejects a missing/invalid alertId", async () => {
    const res = await post({ status: "resolved" })
    expect(res.status).toBe(400)
    expect(mock.updateAlertStatus).not.toHaveBeenCalled()
  })

  it("rejects an invalid status", async () => {
    const res = await post({ alertId: 3, status: "deleted" })
    expect(res.status).toBe(400)
    expect(mock.updateAlertStatus).not.toHaveBeenCalled()
  })

  it("acknowledges an alert scoped to the session tenant and actor", async () => {
    const res = await post({ alertId: 3, status: "acknowledged" })
    expect(res.status).toBe(200)
    expect(mock.updateAlertStatus).toHaveBeenCalledWith(7, 3, "acknowledged", 5)
  })

  it("returns 404 when the alert is not owned by the tenant (store returns false)", async () => {
    mock.updateAlertStatus.mockResolvedValue(false)
    const res = await post({ alertId: 3, status: "resolved" })
    expect(res.status).toBe(404)
  })

  it("does not trust a client-supplied tenantId — always uses the session tenant", async () => {
    await post({ alertId: 3, status: "resolved", tenantId: 999 })
    expect(mock.updateAlertStatus).toHaveBeenCalledWith(7, 3, "resolved", 5)
  })
})
