import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * SPEC 19 (req #74) — Phase 4 verification for the request-time PERMISSION gate
 * that every document-intelligence route runs first (requireDocIntel):
 *
 *   - unauthenticated            → 401,
 *   - authenticated but no tenant in context → 400,
 *   - authenticated + tenant but missing the feature permission → 403 (fail-closed),
 *   - authorized                 → resolves the actor + tenant and reports the
 *     tenant-level AI authorization used by the fail-closed processing gate.
 *
 * The auth/tenant/permission/settings subsystems are mocked so the test pins the
 * gate's wiring, not their internals.
 */

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  currentTenantIdOrNull: vi.fn(),
  userHasFeature: vi.fn(),
  isModuleEnabled: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ getSession: auth.getSession }))
vi.mock("@/lib/tenant-scope", () => ({ currentTenantIdOrNull: auth.currentTenantIdOrNull }))
vi.mock("@/lib/permissions", () => ({ userHasFeature: auth.userHasFeature }))
vi.mock("@/lib/settings/server", () => ({ isModuleEnabled: auth.isModuleEnabled }))

import { requireDocIntel, isResponse, serviceError, DOC_INTEL_FEATURE } from "@/lib/ai/document-intelligence/request"

const SESSION = { userId: 5, role: "employee" as const }

beforeEach(() => {
  vi.clearAllMocks()
  auth.getSession.mockResolvedValue(SESSION)
  auth.currentTenantIdOrNull.mockReturnValue(7)
  auth.userHasFeature.mockResolvedValue(true)
  auth.isModuleEnabled.mockResolvedValue(true)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("requireDocIntel — permission gate", () => {
  it("returns 401 when there is no session", async () => {
    auth.getSession.mockResolvedValue(null)
    const res = await requireDocIntel()
    expect(isResponse(res)).toBe(true)
    if (isResponse(res)) expect(res.status).toBe(401)
  })

  it("returns 400 when there is no tenant in context", async () => {
    auth.currentTenantIdOrNull.mockReturnValue(null)
    const res = await requireDocIntel()
    expect(isResponse(res)).toBe(true)
    if (isResponse(res)) expect(res.status).toBe(400)
  })

  it("returns 403 when the user lacks the feature permission (fail-closed)", async () => {
    auth.userHasFeature.mockResolvedValue(false)
    const res = await requireDocIntel()
    expect(isResponse(res)).toBe(true)
    if (isResponse(res)) expect(res.status).toBe(403)
    expect(auth.userHasFeature).toHaveBeenCalledWith(SESSION.userId, SESSION.role, DOC_INTEL_FEATURE)
  })

  it("resolves the actor + tenant and reports tenant AI authorization when authorized", async () => {
    const res = await requireDocIntel()
    expect(isResponse(res)).toBe(false)
    if (!isResponse(res)) {
      expect(res.tenantId).toBe(7)
      expect(res.actor).toEqual({ userId: 5, role: "employee", isAdmin: false })
      expect(res.tenantAuthorized).toBe(true)
    }
  })

  it("reports tenantAuthorized=false when the AI module is disabled (drives the fail-closed processing gate)", async () => {
    auth.isModuleEnabled.mockResolvedValue(false)
    const res = await requireDocIntel()
    expect(isResponse(res)).toBe(false)
    if (!isResponse(res)) expect(res.tenantAuthorized).toBe(false)
  })

  it("marks an admin actor as isAdmin", async () => {
    auth.getSession.mockResolvedValue({ userId: 1, role: "admin" })
    const res = await requireDocIntel()
    if (!isResponse(res)) expect(res.actor.isAdmin).toBe(true)
  })
})

describe("serviceError", () => {
  it("maps a service error into a NextResponse with the given status", async () => {
    const res = serviceError({ error: "nope", status: 409 })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toEqual({ error: "nope" })
  })
})
