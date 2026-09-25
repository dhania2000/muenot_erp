import { describe, it, expect } from "vitest"
import {
  classifyPlatformAccount,
  effectiveSessionMinutes,
  evaluatePlatformAdminAuth,
  isBreakGlassPlatformAdmin,
  isExemptFromTenantDevicePolicy,
  parseBreakGlassPlatformAdminIds,
  parsePlatformAdminSecurityPolicy,
  securityPolicyLevelFor,
  tenantPolicyExemptionsFor,
} from "@/lib/platform-admin-policy"

describe("classifyPlatformAccount", () => {
  it("only the DB platform role makes a super admin", () => {
    expect(classifyPlatformAccount({ platformRole: "platform_super_admin", isBreakGlassPlatformAdmin: false })).toBe(
      "platform_super_admin",
    )
    for (const role of ["none", "tenant_admin", "tenant_owner", "SUPER_ADMIN", "", null, undefined]) {
      expect(classifyPlatformAccount({ platformRole: role, isBreakGlassPlatformAdmin: false })).toBe("normal")
    }
  })

  it("break-glass outranks super admin", () => {
    expect(classifyPlatformAccount({ platformRole: "platform_super_admin", isBreakGlassPlatformAdmin: true })).toBe(
      "break_glass_platform_admin",
    )
    expect(classifyPlatformAccount({ platformRole: "none", isBreakGlassPlatformAdmin: true })).toBe(
      "break_glass_platform_admin",
    )
  })

  it("maps policy levels", () => {
    expect(securityPolicyLevelFor("break_glass_platform_admin")).toBe("platform_emergency")
    expect(securityPolicyLevelFor("platform_super_admin")).toBe("platform_admin")
    expect(securityPolicyLevelFor("normal")).toBe("tenant")
  })
})

describe("tenant policy exemptions", () => {
  it("normal users (incl. tenant admins) are never exempt", () => {
    expect(isExemptFromTenantDevicePolicy("normal")).toBe(false)
    expect(Object.values(tenantPolicyExemptionsFor("normal")).some(Boolean)).toBe(false)
  })

  it("super admin is exempt from managed device only", () => {
    expect(tenantPolicyExemptionsFor("platform_super_admin")).toEqual({
      managedDevice: true,
      geo: false,
      ipAllowlist: false,
      accessPolicyDeny: false,
      tenantMfaEnrollment: false,
      tenantPhishingResistantMfa: false,
    })
  })

  it("break-glass is exempt from every lockout-capable tenant control", () => {
    expect(Object.values(tenantPolicyExemptionsFor("break_glass_platform_admin")).every(Boolean)).toBe(true)
  })
})

describe("break-glass allow-list", () => {
  it("parses ids and ignores junk", () => {
    expect(parseBreakGlassPlatformAdminIds(" 1, 2\n3 x -4 0 2.5 3")).toEqual([1, 2, 3])
    expect(parseBreakGlassPlatformAdminIds(undefined)).toEqual([])
  })

  it("matches only configured ids", () => {
    expect(isBreakGlassPlatformAdmin(7, "3,7")).toBe(true)
    expect(isBreakGlassPlatformAdmin(8, "3,7")).toBe(false)
    expect(isBreakGlassPlatformAdmin(7, "")).toBe(false)
  })
})

describe("platform admin security policy", () => {
  it("defaults to no mandate and no cap", () => {
    expect(parsePlatformAdminSecurityPolicy({})).toEqual({
      requireMfa: false,
      requirePhishingResistantMfa: false,
      sessionTimeoutMinutes: null,
    })
  })

  it("parses env flags", () => {
    expect(
      parsePlatformAdminSecurityPolicy({
        PLATFORM_ADMIN_REQUIRE_MFA: "TRUE",
        PLATFORM_ADMIN_REQUIRE_PHISHING_RESISTANT_MFA: "true",
        PLATFORM_ADMIN_SESSION_TIMEOUT_MINUTES: "60",
      }),
    ).toEqual({ requireMfa: true, requirePhishingResistantMfa: true, sessionTimeoutMinutes: 60 })
    expect(parsePlatformAdminSecurityPolicy({ PLATFORM_ADMIN_SESSION_TIMEOUT_MINUTES: "0" }).sessionTimeoutMinutes).toBeNull()
  })

  it("caps session only for platform admins", () => {
    const policy = { requireMfa: false, requirePhishingResistantMfa: false, sessionTimeoutMinutes: 60 }
    expect(effectiveSessionMinutes("normal", 480, policy)).toBe(480)
    expect(effectiveSessionMinutes("platform_super_admin", 480, policy)).toBe(60)
    expect(effectiveSessionMinutes("break_glass_platform_admin", 30, policy)).toBe(30)
  })
})

describe("evaluatePlatformAdminAuth", () => {
  it("does not decide for normal users", () => {
    expect(evaluatePlatformAdminAuth({ accountClass: "normal", requireMfa: true, mfaEnabled: false, mfaVerified: false }).allowed).toBe(true)
  })

  it("super admin: enrollment then challenge when required", () => {
    const base = { accountClass: "platform_super_admin" as const, requireMfa: true }
    expect(evaluatePlatformAdminAuth({ ...base, mfaEnabled: false, mfaVerified: false }).code).toBe("MFA_ENROLLMENT_REQUIRED")
    expect(evaluatePlatformAdminAuth({ ...base, mfaEnabled: true, mfaVerified: false }).code).toBe("MFA_REQUIRED")
    expect(evaluatePlatformAdminAuth({ ...base, mfaEnabled: true, mfaVerified: true }).allowed).toBe(true)
    expect(
      evaluatePlatformAdminAuth({ ...base, requireMfa: false, mfaEnabled: false, mfaVerified: false }).allowed,
    ).toBe(true)
  })

  it("break-glass is never blocked on enrollment but enrolled MFA is challenged", () => {
    const base = { accountClass: "break_glass_platform_admin" as const, requireMfa: true }
    expect(evaluatePlatformAdminAuth({ ...base, mfaEnabled: false, mfaVerified: false }).allowed).toBe(true)
    expect(evaluatePlatformAdminAuth({ ...base, mfaEnabled: true, mfaVerified: false }).code).toBe("MFA_REQUIRED")
  })
})
