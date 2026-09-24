import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Server-validated organization switcher (HTTP layer).
 * ---------------------------------------------------------------------------
 * These tests exercise the /api/organizations and /api/organizations/switch
 * route handlers directly, asserting the SECURITY invariants:
 *   - unauthenticated callers are rejected,
 *   - the switch target list is derived only from the caller's live memberships,
 *   - switching into a tenant requires a live, active membership (the
 *     switching-isolation gate) — a forged tenantId is refused with 403,
 *   - switching to the home tenant clears the active override,
 *   - every switch/reset re-mints the session token and writes an audit row.
 *
 * All collaborators (auth, membership, roles, settings) are mocked so the test
 * asserts the handler's decisions, not a live DB or cookie jar.
 */

const getSession = vi.fn()
const createSessionToken = vi.fn(async () => "new.signed.token")
const setSessionCookie = vi.fn(async () => {})

const listMembershipsForUser = vi.fn()
const isActiveMembership = vi.fn()
const getMembershipRole = vi.fn()

const getStoredRoles = vi.fn(async () => ({ platformRole: "none", tenantRole: "employee" }))
const recordPlatformAudit = vi.fn(async () => {})
const resolveTenantIdForUser = vi.fn(async () => 1)
const getNum = vi.fn(async () => 480)

vi.mock("@/lib/auth", () => ({
  getSession: (...a: any[]) => getSession(...a),
  createSessionToken: (...a: any[]) => createSessionToken(...a),
  setSessionCookie: (...a: any[]) => setSessionCookie(...a),
}))
vi.mock("@/lib/tenant-membership", () => ({
  listMembershipsForUser: (...a: any[]) => listMembershipsForUser(...a),
  isActiveMembership: (...a: any[]) => isActiveMembership(...a),
  getMembershipRole: (...a: any[]) => getMembershipRole(...a),
}))
vi.mock("@/lib/platform-roles", () => ({
  getStoredRoles: (...a: any[]) => getStoredRoles(...a),
  recordPlatformAudit: (...a: any[]) => recordPlatformAudit(...a),
}))
vi.mock("@/lib/tenant-service", () => ({
  resolveTenantIdForUser: (...a: any[]) => resolveTenantIdForUser(...a),
}))
vi.mock("@/lib/settings/server", () => ({
  getNum: (...a: any[]) => getNum(...a),
}))

import { GET } from "@/app/api/organizations/route"
import { POST, DELETE } from "@/app/api/organizations/switch/route"

const SESSION = {
  userId: 5,
  email: "owner@acme.test",
  name: "Owner",
  role: "admin",
  tenantId: 1,
  platformRole: "none",
  tenantRole: "tenant_owner",
  activeTenantId: null,
  sid: "sess-1",
}

function jsonReq(body: unknown) {
  return {
    json: async () => body,
  } as any
}

beforeEach(() => {
  getSession.mockResolvedValue(SESSION)
  resolveTenantIdForUser.mockResolvedValue(1)
  getNum.mockResolvedValue(480)
  getStoredRoles.mockResolvedValue({ platformRole: "none", tenantRole: "employee" })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/organizations (switch targets)", () => {
  it("401s when unauthenticated", async () => {
    getSession.mockResolvedValueOnce(null)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it("lists only the caller's live memberships and flags home + active", async () => {
    listMembershipsForUser.mockResolvedValueOnce([
      { tenantId: 1, tenantName: "Home", tenantSlug: "home", tenantRole: "tenant_owner", isPrimary: true },
      { tenantId: 2, tenantName: "Acme", tenantSlug: "acme", tenantRole: "tenant_admin", isPrimary: false },
    ])
    const res = await GET()
    const body = await res.json()
    expect(listMembershipsForUser).toHaveBeenCalledWith(5)
    expect(body.homeTenantId).toBe(1)
    expect(body.activeTenantId).toBe(1)
    const home = body.organizations.find((o: any) => o.tenantId === 1)
    const acme = body.organizations.find((o: any) => o.tenantId === 2)
    expect(home).toMatchObject({ isHome: true, isActive: true })
    expect(acme).toMatchObject({ isHome: false, isActive: false })
  })

  it("falls back to home when the switched-into tenant is no longer a membership", async () => {
    // Session claims active tenant 99 but the user has no membership there.
    getSession.mockResolvedValueOnce({ ...SESSION, activeTenantId: 99 })
    listMembershipsForUser.mockResolvedValueOnce([
      { tenantId: 1, tenantName: "Home", tenantSlug: "home", tenantRole: "tenant_owner", isPrimary: true },
    ])
    const res = await GET()
    const body = await res.json()
    expect(body.activeTenantId).toBe(1)
  })
})

describe("POST /api/organizations/switch (switching-isolation gate)", () => {
  it("401s when unauthenticated", async () => {
    getSession.mockResolvedValueOnce(null)
    const res = await POST(jsonReq({ tenantId: 2 }))
    expect(res.status).toBe(401)
  })

  it("400s on a missing/invalid tenantId", async () => {
    const res = await POST(jsonReq({ tenantId: "nope" }))
    expect(res.status).toBe(400)
    expect(isActiveMembership).not.toHaveBeenCalled()
  })

  it("403s when the caller is NOT a live member of the target (forged tenantId)", async () => {
    isActiveMembership.mockResolvedValueOnce(false)
    const res = await POST(jsonReq({ tenantId: 777 }))
    expect(res.status).toBe(403)
    expect(isActiveMembership).toHaveBeenCalledWith(5, 777)
    // A refused switch must not re-mint the session.
    expect(createSessionToken).not.toHaveBeenCalled()
    expect(setSessionCookie).not.toHaveBeenCalled()
  })

  it("switches into a tenant the caller is a live member of, re-mints, and audits", async () => {
    isActiveMembership.mockResolvedValueOnce(true)
    getMembershipRole.mockResolvedValueOnce("tenant_admin")
    const res = await POST(jsonReq({ tenantId: 2 }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, activeTenantId: 2 })
    // Re-minted with activeTenantId = 2 and the target's role hint.
    const payload = createSessionToken.mock.calls[0][0]
    expect(payload).toMatchObject({ activeTenantId: 2, tenantRole: "tenant_admin", sid: "sess-1" })
    expect(setSessionCookie).toHaveBeenCalledOnce()
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "organization_switch", targetTenantId: 2 }),
    )
  })

  it("treats switching to the home tenant as a reset (clears activeTenantId, no membership gate)", async () => {
    getMembershipRole.mockResolvedValueOnce("tenant_owner")
    const res = await POST(jsonReq({ tenantId: 1 }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.activeTenantId).toBeNull()
    // Home reset does not require the isActiveMembership gate.
    expect(isActiveMembership).not.toHaveBeenCalled()
    const payload = createSessionToken.mock.calls[0][0]
    expect(payload.activeTenantId).toBeNull()
  })
})

describe("DELETE /api/organizations/switch (reset to home)", () => {
  it("401s when unauthenticated", async () => {
    getSession.mockResolvedValueOnce(null)
    const res = await DELETE()
    expect(res.status).toBe(401)
  })

  it("clears the active override and audits when one was set", async () => {
    getSession.mockResolvedValueOnce({ ...SESSION, activeTenantId: 2 })
    getMembershipRole.mockResolvedValueOnce("tenant_owner")
    const res = await DELETE()
    const body = await res.json()
    expect(body.activeTenantId).toBeNull()
    const payload = createSessionToken.mock.calls[0][0]
    expect(payload.activeTenantId).toBeNull()
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "organization_switch", detail: expect.objectContaining({ from: 2 }) }),
    )
  })

  it("does not audit when there was no active override to clear", async () => {
    getSession.mockResolvedValueOnce({ ...SESSION, activeTenantId: null })
    getMembershipRole.mockResolvedValueOnce("tenant_owner")
    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(recordPlatformAudit).not.toHaveBeenCalled()
  })
})
