import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ guard: vi.fn(), listLogs: vi.fn(), dashboard: vi.fn(), updateIncident: vi.fn() }))
vi.mock("@/lib/platform-guard", () => ({ requirePlatformSuperAdmin: mock.guard }))
vi.mock("@/lib/system-monitoring", () => ({ monitorLogger: { warning: vi.fn() } }))
vi.mock("@/lib/system-monitoring-store", () => ({
  listLogs: mock.listLogs, dashboard: mock.dashboard, updateIncident: mock.updateIncident,
  positiveId: (value: string | null) => { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null },
  rangeHours: () => 24, getIncident: vi.fn(), getLog: vi.fn(), health: vi.fn(), listAlerts: vi.fn(),
  listIncidents: vi.fn(), settings: vi.fn(), addAlert: vi.fn(), auditMonitor: vi.fn(), updateSettings: vi.fn(),
}))
import { GET, POST } from "@/app/api/platform/system-monitoring/[[...parts]]/route"

describe("monitoring platform authorization", () => {
  beforeEach(() => { vi.clearAllMocks(); mock.guard.mockResolvedValue({ ok: false, status: 403, reason: "Platform privileges required" }) })
  it("rejects ordinary tenant users before reading cross-tenant logs", async () => {
    const response = await GET(new Request("https://example.test/api/platform/system-monitoring/logs?tenantId=177"), { params: Promise.resolve({ parts: ["logs"] }) })
    expect(response.status).toBe(403)
    expect(mock.listLogs).not.toHaveBeenCalled()
  })
  it("rejects incident mutations for non-super-admins", async () => {
    const response = await POST(new Request("https://example.test/api/platform/system-monitoring/incidents/7/action", { method: "POST", body: JSON.stringify({ action: "resolve" }) }), { params: Promise.resolve({ parts: ["incidents", "7", "action"] }) })
    expect(response.status).toBe(403)
    expect(mock.updateIncident).not.toHaveBeenCalled()
  })
  it("permits the super admin to query the real store", async () => {
    mock.guard.mockResolvedValue({ ok: true, session: { userId: 1 } })
    mock.listLogs.mockResolvedValue({ items: [], nextCursor: null })
    const response = await GET(new Request("https://example.test/api/platform/system-monitoring/logs"), { params: Promise.resolve({ parts: ["logs"] }) })
    expect(response.status).toBe(200)
    expect(mock.listLogs).toHaveBeenCalledOnce()
  })
})
