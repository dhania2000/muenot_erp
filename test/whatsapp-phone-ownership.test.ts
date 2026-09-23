import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ guard: vi.fn(), poolQuery: vi.fn(), query: vi.fn(), transaction: vi.fn(), row: null as any }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/platform-guard", () => ({ requirePlatformSuperAdmin: mock.guard }))
vi.mock("@/lib/db", () => ({ pool: { query: mock.poolQuery }, query: mock.query, withTransaction: mock.transaction }))
vi.mock("@/lib/whatsapp", () => ({ ensureWhatsAppTable: async () => {} }))
vi.mock("@/lib/whatsapp-registration", () => ({ ensureRegistrationSchema: async () => {}, withWhatsAppLock: async (_key: string, fn: () => Promise<unknown>) => fn() }))

import { disconnectTenantWhatsAppIntegration, inspectWhatsAppPhoneOwnership, releaseWhatsAppPhoneOwnership } from "@/lib/whatsapp-phone-ownership"
import { GET, POST } from "@/app/api/platform/whatsapp/phone-ownership/route"

const url = "https://erp.muenot.co.in/api/platform/whatsapp/phone-ownership"
const post = (body: unknown) => new Request(url, { method: "POST", body: JSON.stringify(body) })
const reviewed = { phoneNumberId: "200", ownerTenantId: 99 }
const request = { integrationId: 4, ...reviewed, reason: "Confirmed inactive test tenant account", confirmation: "RELEASE" }

beforeEach(() => {
  vi.clearAllMocks()
  mock.guard.mockResolvedValue({ ok: true, ctx: { userId: 12, platformRole: "platform_super_admin" }, session: { email: "admin@example.test" } })
  mock.row = { id: 4, tenant_id: 99, tenant_status: "inactive", phone_number_id: "200", waba_id: "100",
    released_at: null, connected_at: "2026-09-01", registration_status: "failed", has_credential: 1 }
  mock.query.mockResolvedValue([])
  mock.poolQuery.mockImplementation(async (sql: string) => sql.includes("WHERE id=? LIMIT 1") ? [[{ phone_number_id: "200" }]] : [[mock.row]])
  mock.transaction.mockImplementation(async (fn: (connection: { query: typeof mock.query }) => Promise<unknown>) => fn({ query: mock.query }))
  mock.query.mockImplementation(async (sql: string) => sql.includes("WHERE i.id=? FOR UPDATE") ? [[mock.row]] : [[], []])
})

describe("platform WhatsApp ownership inspection and release", () => {
  it.each([401, 403])("rejects unauthorized inspection and release (%i)", async status => {
    mock.guard.mockResolvedValue({ ok: false, status, reason: "Forbidden" })
    expect((await GET(new Request(url + "?phoneNumberId=200"))).status).toBe(status)
    expect((await POST(post(request))).status).toBe(status)
    expect(mock.poolQuery).not.toHaveBeenCalled()
  })

  it("also rejects a non-super-admin service caller", async () => {
    expect(() => releaseWhatsAppPhoneOwnership(4, { userId: 12, platformRole: "platform_staff" }, request.reason, reviewed))
      .toThrow("Platform super-admin privileges required.")
    expect(mock.poolQuery).not.toHaveBeenCalled()
  })

  it("returns only ownership metadata, never credentials", async () => {
    const result = await inspectWhatsAppPhoneOwnership("200")
    expect(result[0]).toMatchObject({ integrationId: 4, ownerTenantId: 99, ownerTenantStatus: "inactive", integrationStatus: "assigned" })
    expect(JSON.stringify(result)).not.toContain("access_token")
    expect(JSON.stringify(result)).not.toContain("waba_id")
    expect((await GET(new Request(url + "?phoneNumberId=200"))).status).toBe(200)
  })

  it("refuses a still-active tenant connection even for a Super Admin", async () => {
    mock.row.tenant_status = "active"
    expect((await POST(post(request))).status).toBe(409)
    expect(mock.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE marketing_whatsapp_integration"))).toBe(false)
  })

  it("releases a reviewed inactive owner, revokes the stored credential and audits atomically", async () => {
    expect(await releaseWhatsAppPhoneOwnership(4, { userId: 12, platformRole: "platform_super_admin" }, request.reason, reviewed)).toEqual({ released: true, alreadyReleased: false })
    const statements = mock.query.mock.calls.map(([sql]) => sql as string)
    expect(statements.some(sql => sql.includes("SET released_at=UTC_TIMESTAMP(), access_token=''"))).toBe(true)
    expect(statements.some(sql => sql.includes("registration_status='released'"))).toBe(true)
    const audit = mock.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO marketing_whatsapp_ownership_events"))
    expect(audit?.[1]).toEqual([4, 99, "200", "platform_release", 12, request.reason])
    expect(JSON.stringify(mock.query.mock.calls)).not.toContain("test-only-token")
  })

  it("allows the owning tenant to disconnect while preserving the old row and an audit event", async () => {
    mock.row.tenant_status = "active"
    expect(await disconnectTenantWhatsAppIntegration(4, 99, 21)).toEqual({ released: true, alreadyReleased: false })
    const audit = mock.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO marketing_whatsapp_ownership_events"))
    expect(audit?.[1]).toEqual([4, 99, "200", "tenant_disconnect", 21, "Disconnected by the owning tenant administrator."])
    expect(mock.query.mock.calls.some(([sql]) => sql.includes("DELETE FROM marketing_whatsapp_integration"))).toBe(false)
  })

  it("rejects a forged tenant-scoped disconnect", async () => {
    await expect(disconnectTenantWhatsAppIntegration(4, 177, 21)).rejects.toMatchObject({ status: 403 })
    expect(mock.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE marketing_whatsapp_integration"))).toBe(false)
  })

  it("rejects changed ownership and repeated release without an extra audit event", async () => {
    expect((await POST(post({ ...request, ownerTenantId: 88 }))).status).toBe(409)
    expect(mock.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO marketing_whatsapp_ownership_events"))).toBe(false)
    mock.row.released_at = "2026-09-23"
    expect(await releaseWhatsAppPhoneOwnership(4, { userId: 12, platformRole: "platform_super_admin" }, request.reason, reviewed)).toEqual({ released: true, alreadyReleased: true })
    expect(mock.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO marketing_whatsapp_ownership_events"))).toBe(false)
  })

  it("requires explicit review confirmation and a reason", async () => {
    expect((await POST(post({ ...request, confirmation: "" }))).status).toBe(400)
    expect((await POST(post({ ...request, reason: "short" }))).status).toBe(400)
  })
})
