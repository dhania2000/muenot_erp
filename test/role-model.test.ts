import { describe, it, expect } from "vitest"
import {
  type RoleContext,
  type PlatformRole,
  type TenantRole,
  canActOnPlatform,
  canActOnTenant,
  canAssignPlatformRole,
  canAssignTenantRole,
  effectiveTenantId,
  isImpersonating,
  isPlatformUser,
  legacyToTenantRole,
  platformAtLeast,
  tenantAtLeast,
  tenantRoleToLegacy,
} from "@/lib/role-model"

/**
 * SPEC 3 — Phase 4. These tests are the evidence that the platform/tenant
 * boundary holds: a platform role never leaks tenant-data authority, a tenant
 * role never reaches the platform, impersonation is bounded, and no actor can
 * escalate privileges (their own or others') beyond what they already hold.
 *
 * The module under test is pure (no DB / server-only imports), so the whole
 * boundary is exercised deterministically here.
 */

const HOME = 100
const CUSTOMER = 200
const OTHER = 300

function ctx(overrides: Partial<RoleContext> = {}): RoleContext {
  return {
    userId: 1,
    homeTenantId: HOME,
    isPlatformOwnerTenant: false,
    platformRole: "none",
    tenantRole: "employee",
    impersonatedTenantId: null,
    ...overrides,
  }
}

describe("rank helpers", () => {
  it("orders the platform axis none < staff < super_admin", () => {
    expect(platformAtLeast("platform_staff", "none")).toBe(true)
    expect(platformAtLeast("platform_staff", "platform_super_admin")).toBe(false)
    expect(platformAtLeast("platform_super_admin", "platform_staff")).toBe(true)
    expect(platformAtLeast("none", "platform_staff")).toBe(false)
  })

  it("orders the tenant axis employee < module_admin < tenant_admin < tenant_owner", () => {
    expect(tenantAtLeast("module_admin", "employee")).toBe(true)
    expect(tenantAtLeast("tenant_admin", "module_admin")).toBe(true)
    expect(tenantAtLeast("tenant_owner", "tenant_admin")).toBe(true)
    expect(tenantAtLeast("module_admin", "tenant_admin")).toBe(false)
    expect(tenantAtLeast("employee", "module_admin")).toBe(false)
  })

  it("isPlatformUser is true only for non-none platform roles", () => {
    expect(isPlatformUser("none")).toBe(false)
    expect(isPlatformUser("platform_staff")).toBe(true)
    expect(isPlatformUser("platform_super_admin")).toBe(true)
  })

  it("legacy role mapping round-trips through the tenant axis", () => {
    expect(tenantRoleToLegacy("tenant_owner")).toBe("admin")
    expect(tenantRoleToLegacy("tenant_admin")).toBe("admin")
    expect(tenantRoleToLegacy("module_admin")).toBe("employee")
    expect(tenantRoleToLegacy("employee")).toBe("employee")
    expect(legacyToTenantRole("admin")).toBe("tenant_admin")
    expect(legacyToTenantRole("employee")).toBe("employee")
  })
})

describe("effective tenant & impersonation state", () => {
  it("defaults to the home tenant with no impersonation", () => {
    const c = ctx()
    expect(effectiveTenantId(c)).toBe(HOME)
    expect(isImpersonating(c)).toBe(false)
  })

  it("switches to the impersonated tenant when one is active", () => {
    const c = ctx({ platformRole: "platform_super_admin", impersonatedTenantId: CUSTOMER })
    expect(effectiveTenantId(c)).toBe(CUSTOMER)
    expect(isImpersonating(c)).toBe(true)
  })

  it("does not treat impersonating your own home tenant as impersonation", () => {
    const c = ctx({ platformRole: "platform_staff", impersonatedTenantId: HOME })
    expect(isImpersonating(c)).toBe(false)
    expect(effectiveTenantId(c)).toBe(HOME)
  })
})

describe("THE BOUNDARY — platform role never grants tenant authority", () => {
  it("a platform super admin with NO impersonation cannot act on any tenant", () => {
    const superAdmin = ctx({
      platformRole: "platform_super_admin",
      tenantRole: "employee",
      homeTenantId: HOME,
    })
    // Not even their own home tenant beyond their real (employee) tenant role.
    expect(canActOnTenant(superAdmin, HOME, "tenant_admin")).toBe(false)
    // And certainly not a customer tenant.
    expect(canActOnTenant(superAdmin, CUSTOMER, "employee")).toBe(false)
    expect(canActOnTenant(superAdmin, CUSTOMER, "tenant_admin")).toBe(false)
  })

  it("a platform operator can only act on the EXACT tenant they impersonate", () => {
    const op = ctx({ platformRole: "platform_super_admin", impersonatedTenantId: CUSTOMER })
    expect(canActOnTenant(op, CUSTOMER, "tenant_admin")).toBe(true)
    // A different tenant than the one being impersonated is always rejected.
    expect(canActOnTenant(op, OTHER, "tenant_admin")).toBe(false)
    expect(canActOnTenant(op, HOME, "employee")).toBe(false)
  })

  it("impersonation is capped at tenant_admin — never tenant_owner", () => {
    const op = ctx({ platformRole: "platform_super_admin", impersonatedTenantId: CUSTOMER })
    expect(canActOnTenant(op, CUSTOMER, "tenant_admin")).toBe(true)
    expect(canActOnTenant(op, CUSTOMER, "tenant_owner")).toBe(false)
  })
})

describe("THE BOUNDARY — tenant role never grants platform authority", () => {
  it("a customer tenant_owner cannot reach the platform", () => {
    const owner = ctx({ platformRole: "none", tenantRole: "tenant_owner" })
    expect(canActOnPlatform(owner, "platform_staff")).toBe(false)
    expect(canActOnPlatform(owner, "platform_super_admin")).toBe(false)
  })

  it("platform authority tracks only the platform axis", () => {
    expect(canActOnPlatform(ctx({ platformRole: "platform_staff" }), "platform_staff")).toBe(true)
    expect(canActOnPlatform(ctx({ platformRole: "platform_staff" }), "platform_super_admin")).toBe(false)
    expect(canActOnPlatform(ctx({ platformRole: "platform_super_admin" }), "platform_super_admin")).toBe(true)
  })
})

describe("tenant authority without impersonation comes purely from the user's own role", () => {
  const cases: Array<[TenantRole, TenantRole, boolean]> = [
    ["tenant_owner", "tenant_owner", true],
    ["tenant_admin", "tenant_owner", false],
    ["tenant_admin", "tenant_admin", true],
    ["module_admin", "tenant_admin", false],
    ["module_admin", "module_admin", true],
    ["employee", "module_admin", false],
  ]
  for (const [role, min, expected] of cases) {
    it(`${role} acting-as ${min} on home tenant => ${expected}`, () => {
      expect(canActOnTenant(ctx({ tenantRole: role }), HOME, min)).toBe(expected)
    })
  }

  it("a user can never act on a tenant that is not their own", () => {
    expect(canActOnTenant(ctx({ tenantRole: "tenant_owner" }), CUSTOMER, "employee")).toBe(false)
  })
})

describe("privilege escalation — platform role assignment", () => {
  const superAdmin = ctx({ platformRole: "platform_super_admin" })
  const staff = ctx({ platformRole: "platform_staff" })
  const tenantOnly = ctx({ platformRole: "none", tenantRole: "tenant_owner" })

  it("a non-operator can never assign any platform role", () => {
    for (const target of ["platform_staff", "platform_super_admin"] as PlatformRole[]) {
      expect(canAssignPlatformRole(tenantOnly, target)).toBe(false)
    }
  })

  it("staff cannot mint a super admin, but a super admin can", () => {
    expect(canAssignPlatformRole(staff, "platform_super_admin")).toBe(false)
    expect(canAssignPlatformRole(superAdmin, "platform_super_admin")).toBe(true)
  })

  it("no operator can grant above their own level", () => {
    expect(canAssignPlatformRole(staff, "platform_staff")).toBe(true)
    expect(canAssignPlatformRole(staff, "platform_super_admin")).toBe(false)
    expect(canAssignPlatformRole(superAdmin, "platform_staff")).toBe(true)
  })
})

describe("privilege escalation — tenant role assignment", () => {
  it("a tenant_admin can grant up to tenant_admin but never tenant_owner", () => {
    const admin = ctx({ tenantRole: "tenant_admin" })
    expect(canAssignTenantRole(admin, HOME, "employee")).toBe(true)
    expect(canAssignTenantRole(admin, HOME, "module_admin")).toBe(true)
    expect(canAssignTenantRole(admin, HOME, "tenant_admin")).toBe(true)
    expect(canAssignTenantRole(admin, HOME, "tenant_owner")).toBe(false)
  })

  it("only a real tenant_owner can confer ownership", () => {
    const owner = ctx({ tenantRole: "tenant_owner" })
    expect(canAssignTenantRole(owner, HOME, "tenant_owner")).toBe(true)
  })

  it("a module_admin cannot assign roles at all (needs tenant_admin authority)", () => {
    const moduleAdmin = ctx({ tenantRole: "module_admin" })
    expect(canAssignTenantRole(moduleAdmin, HOME, "employee")).toBe(false)
  })

  it("an impersonating operator can assign up to tenant_admin but NEVER tenant_owner", () => {
    const op = ctx({
      platformRole: "platform_super_admin",
      tenantRole: "employee",
      impersonatedTenantId: CUSTOMER,
    })
    expect(canAssignTenantRole(op, CUSTOMER, "employee")).toBe(true)
    expect(canAssignTenantRole(op, CUSTOMER, "module_admin")).toBe(true)
    expect(canAssignTenantRole(op, CUSTOMER, "tenant_admin")).toBe(true)
    // The critical escalation guard: impersonation can never create an owner.
    expect(canAssignTenantRole(op, CUSTOMER, "tenant_owner")).toBe(false)
    // And never touches a tenant other than the impersonated one.
    expect(canAssignTenantRole(op, OTHER, "employee")).toBe(false)
  })

  it("a non-impersonating platform operator has no tenant assignment power", () => {
    const op = ctx({ platformRole: "platform_super_admin", tenantRole: "employee" })
    expect(canAssignTenantRole(op, HOME, "employee")).toBe(false)
    expect(canAssignTenantRole(op, CUSTOMER, "employee")).toBe(false)
  })
})
