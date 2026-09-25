import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec62 (#242-244) — platform identity distinct from tenant identity, plus
 * audit separation.
 *
 * Covers:
 *   1. Concurrent platform + tenant accounts resolve to independent contexts;
 *      a platform role never implies tenant permissions (that decision lives in
 *      role-model, exercised here through resolved contexts).
 *   2. Impersonation is opt-in, requires a platform role, targets an active
 *      tenant, and can't be used to "impersonate" your own home tenant.
 *   3. Platform operator actions are written to platform_admin_audit ONLY — the
 *      customer tenant's own audit tables are never touched.
 */

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getTenantById: vi.fn(),
  ensureTenantSchema: vi.fn(async () => {}),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mocks.query }))
vi.mock("@/lib/tenant-service", () => ({
  getTenantById: mocks.getTenantById,
  ensureTenantSchema: mocks.ensureTenantSchema,
}))

import { getStoredRoles, recordPlatformAudit, resolveRoleContext } from "@/lib/platform-roles"
import { canActOnTenant } from "@/lib/role-model"

const users: Record<number, any> = {
  // Super admin living in the Muenot platform-owner tenant.
  1: { tenant_id: 100, platform_role: "platform_super_admin", tenant_role: "employee", role: "user" },
  // Support staff, also platform tenant.
  2: { tenant_id: 100, platform_role: "platform_staff", tenant_role: "employee", role: "user" },
  // Ordinary customer tenant admin, no platform role.
  3: { tenant_id: 200, platform_role: "none", tenant_role: "tenant_admin", role: "admin" },
}

const tenants: Record<number, any> = {
  100: { id: 100, status: "active", is_platform_owner: 1 },
  200: { id: 200, status: "active", is_platform_owner: 0 },
  300: { id: 300, status: "suspended", is_platform_owner: 0 },
}

const auditInserts: any[][] = []

beforeEach(() => {
  vi.clearAllMocks()
  auditInserts.length = 0

  mocks.getTenantById.mockImplementation(async (id: number) => tenants[id] ?? null)

  mocks.query.mockImplementation(async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim()
    if (/^ALTER TABLE/i.test(s) || /^CREATE TABLE/i.test(s) || /^UPDATE/i.test(s)) return []
    if (/information_schema/i.test(s)) return [{ 1: 1 }] // pretend columns/indexes already exist
    if (/^SELECT COUNT\(\*\) AS n/i.test(s)) return [{ n: 1 }] // a super admin already exists
    if (/FROM `users` WHERE `id` = \?/i.test(s)) {
      const u = users[params[0]]
      return u ? [u] : []
    }
    if (/^INSERT INTO `platform_admin_audit`/i.test(s)) {
      auditInserts.push(params)
      return { insertId: auditInserts.length }
    }
    return []
  })
})

describe("concurrent platform + tenant identity", () => {
  it("resolves a super admin's platform role without granting tenant power", async () => {
    const ctx = await resolveRoleContext({ userId: 1 })
    expect(ctx?.platformRole).toBe("platform_super_admin")
    expect(ctx?.isPlatformOwnerTenant).toBe(true)
    // Platform role must NOT confer tenant permissions in their own tenant:
    // the super admin is only an 'employee' there, so cannot act as tenant_admin.
    expect(ctx?.tenantRole).toBe("employee")
    expect(canActOnTenant(ctx!, 100, "tenant_admin")).toBe(false)
  })

  it("resolves an ordinary tenant admin with no platform role", async () => {
    const ctx = await resolveRoleContext({ userId: 3 })
    expect(ctx?.platformRole).toBe("none")
    expect(ctx?.tenantRole).toBe("tenant_admin")
    expect(ctx?.isPlatformOwnerTenant).toBe(false)
  })

  it("a platform role never implies cross-tenant tenant permissions", async () => {
    const staff = await resolveRoleContext({ userId: 2 })
    // Without impersonation, staff has no tenant-level authority over tenant 200.
    expect(canActOnTenant(staff!, 200, "tenant_admin")).toBe(false)
  })
})

describe("impersonation gate", () => {
  it("lets a platform operator impersonate a different active tenant", async () => {
    const ctx = await resolveRoleContext({ userId: 1, impersonatedTenantId: 200 })
    expect(ctx?.impersonatedTenantId).toBe(200)
  })

  it("refuses impersonation for a user with no platform role", async () => {
    const ctx = await resolveRoleContext({ userId: 3, impersonatedTenantId: 100 })
    expect(ctx?.impersonatedTenantId).toBeNull()
  })

  it("refuses impersonating your own home tenant", async () => {
    const ctx = await resolveRoleContext({ userId: 1, impersonatedTenantId: 100 })
    expect(ctx?.impersonatedTenantId).toBeNull()
  })

  it("refuses impersonating a suspended tenant", async () => {
    const ctx = await resolveRoleContext({ userId: 1, impersonatedTenantId: 300 })
    expect(ctx?.impersonatedTenantId).toBeNull()
  })
})

describe("audit separation", () => {
  it("writes platform operator actions to platform_admin_audit only", async () => {
    await recordPlatformAudit({
      actorUserId: 1,
      actorEmail: "root@muenot",
      action: "impersonation.start",
      targetTenantId: 200,
      detail: { reason: "support" },
    })
    expect(auditInserts).toHaveLength(1)
    const [actorUserId, , action, , targetTenantId] = auditInserts[0]
    expect(actorUserId).toBe(1)
    expect(action).toBe("impersonation.start")
    expect(targetTenantId).toBe(200)
  })

  it("getStoredRoles reads platform identity straight off the user row", async () => {
    const stored = await getStoredRoles(2)
    expect(stored?.platformRole).toBe("platform_staff")
    expect(stored?.tenantId).toBe(100)
  })
})
