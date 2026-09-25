import "server-only"
/**
 * Geo + managed-device sign-in protection (Spec25 · #213, #214).
 * ---------------------------------------------------------------------------
 * One orchestration point the login route calls AFTER the password is verified
 * (so a wrong password never reveals policy state) and REGARDLESS of whether
 * the lifecycle snapshot is available, so the checks can never fail open.
 *
 * Emergency access reuses the existing subsystems instead of inventing a new
 * one: a denial may be overridden only when the tenant has enabled emergency
 * access on that policy AND the user is either a platform Super Admin or holds
 * an ACTIVE, approved break-glass grant (lib/temporary-access-store). Every
 * block and every bypass is written to the security audit trail by the stores.
 */
import { enforceGeoPolicy } from "@/lib/geo-policy-store"
import { enforceManagedDevice } from "@/lib/managed-device-store"
import { listActiveBreakGlassForUser } from "@/lib/temporary-access-store"
import type { TrustedGeo } from "@/lib/geo-trust"
import {
  type PlatformAccountClass,
  type SecurityPolicyLevel,
  type TenantPolicyExemptions,
  classifyPlatformAccount,
  isBreakGlassPlatformAdmin,
  isExemptFromTenantDevicePolicy,
  isPlatformAdminClass,
  securityPolicyLevelFor,
  tenantPolicyExemptionsFor,
} from "@/lib/platform-admin-policy"

export type EmergencyAuthorization = {
  authorized: boolean
  via: "platform_super_admin" | "break_glass_grant" | null
  grantId: number | null
}

export async function resolveEmergencyAuthorization(
  tenantId: number | null,
  userId: number,
  platformRole: string | null | undefined,
): Promise<EmergencyAuthorization> {
  if (platformRole === "platform_super_admin") {
    return { authorized: true, via: "platform_super_admin", grantId: null }
  }
  if (tenantId == null) return { authorized: false, via: null, grantId: null }
  try {
    const grants = await listActiveBreakGlassForUser(tenantId, userId)
    if (grants.length > 0) return { authorized: true, via: "break_glass_grant", grantId: grants[0].id }
  } catch (err) {
    // Fail closed: an unreadable grant table never authorizes a bypass.
    console.error("[sign-in-protection] break-glass lookup failed:", err)
  }
  return { authorized: false, via: null, grantId: null }
}

export type SignInProtectionInput = {
  tenantId: number | null
  user: { id: number; name: string; email: string }
  platformRole: string | null | undefined
  ip: string | null
  geo: TrustedGeo
  deviceAssertion: unknown
}

/**
 * The platform-vs-tenant security context resolved for this sign-in. Derived
 * only from server-authoritative inputs (the DB-resolved platform role and the
 * trusted platform break-glass config), never from client input.
 */
export type PlatformSecurityContext = {
  accountClass: PlatformAccountClass
  policyLevel: SecurityPolicyLevel
  /** True ⇒ tenant-owned managed-device / geo enforcement is skipped (precedence). */
  exemptFromTenantDevicePolicy: boolean
}

export type SignInProtectionResult =
  | {
      ok: true
      bypassed: Array<"geo" | "device">
      emergency: EmergencyAuthorization
      platform: PlatformSecurityContext
    }
  | { ok: false; status: 403; code: "GEO_BLOCKED" | "MANAGED_DEVICE_REQUIRED"; error: string }

/**
 * Resolve the platform security context from server-authoritative inputs. The
 * platform role is the DB source of truth (resolved by the caller via
 * lib/platform-roles.ts); break-glass status comes only from trusted platform
 * configuration. No request-controlled value participates.
 */
export function resolvePlatformSecurityContext(
  userId: number,
  platformRole: string | null | undefined,
): PlatformSecurityContext {
  const accountClass = classifyPlatformAccount({
    platformRole,
    isBreakGlassPlatformAdmin: isBreakGlassPlatformAdmin(userId, process.env.PLATFORM_BREAK_GLASS_USER_IDS),
  })
  return {
    accountClass,
    policyLevel: securityPolicyLevelFor(accountClass),
    exemptFromTenantDevicePolicy: isExemptFromTenantDevicePolicy(accountClass),
  }
}

/**
 * Audit a platform-admin / break-glass exemption from tenant device policy.
 * Best-effort and dynamically imported so this decision module stays free of a
 * load-time DB dependency. Break-glass raises a CRITICAL event and notifies
 * platform security admins via the existing notification infrastructure.
 */
async function recordPlatformExemptionAudit(
  input: SignInProtectionInput,
  platform: PlatformSecurityContext,
  exemptions: TenantPolicyExemptions,
): Promise<void> {
  const breakGlass = platform.accountClass === "break_glass_platform_admin"
  try {
    const { recordSecurityEvent } = await import("@/lib/security-audit-store")
    await recordSecurityEvent({
      tenantId: input.tenantId,
      category: breakGlass ? "break_glass" : "emergency_bypass",
      action: breakGlass ? "platform_break_glass_login" : "platform_admin_device_exempt",
      outcome: "bypassed",
      actorUserId: input.user.id,
      actorName: input.user.name,
      subjectEmail: input.user.email,
      ipAddress: input.ip,
      detail: {
        accountClass: platform.accountClass,
        policyLevel: platform.policyLevel,
        exemptions: Object.keys(exemptions).filter((k) => exemptions[k as keyof TenantPolicyExemptions]),
        reason: breakGlass ? "platform_emergency_policy_precedence" : "platform_admin_policy_precedence",
        via: breakGlass ? "break_glass_platform_admin" : "platform_super_admin",
        critical: breakGlass || undefined,
      },
    })
  } catch (err) {
    console.error("[sign-in-protection] platform exemption audit failed:", err)
  }
  if (breakGlass) {
    try {
      const { recordActivity } = await import("@/lib/notifications")
      await recordActivity({
        action: "update",
        title: `Break-glass platform access used by ${input.user.name}`,
        body: `Emergency platform-admin sign-in · ${input.user.email}`,
        link: "/admin/security/emergency-access",
        actor: { userId: input.user.id, name: input.user.name, email: input.user.email, role: "admin" },
      })
    } catch (err) {
      console.error("[sign-in-protection] break-glass notify failed:", err)
    }
  }
}

/**
 * Precedence: PLATFORM_EMERGENCY → PLATFORM_ADMIN → TENANT → USER.
 *
 * The platform context is resolved FIRST from server-authoritative inputs. For a
 * genuine platform admin the tenant-owned managed-device requirement is skipped
 * unconditionally (not gated on the tenant's own "emergency access" flag, which
 * was the root cause of the lockout); break-glass additionally skips tenant geo.
 * Everything not exempted still runs exactly as before.
 */
export async function enforceSignInProtection(input: SignInProtectionInput): Promise<SignInProtectionResult> {
  const platform = resolvePlatformSecurityContext(input.user.id, input.platformRole)
  const exemptions = tenantPolicyExemptionsFor(platform.accountClass)
  const emergency = await resolveEmergencyAuthorization(input.tenantId, input.user.id, input.platformRole)
  const common = {
    userId: input.user.id,
    userName: input.user.name,
    userEmail: input.user.email,
    ip: input.ip,
    emergencyAuthorized: emergency.authorized,
    emergencyVia: emergency.via,
    emergencyGrantId: emergency.grantId,
  }
  const bypassed: Array<"geo" | "device"> = []

  if (exemptions.geo) {
    bypassed.push("geo")
  } else {
    const geoResult = await enforceGeoPolicy(input.tenantId, {
      ...common,
      country: input.geo.country,
      locationMeta: { source: input.geo.source, anonymous: input.geo.anonymous, resolution: input.geo.reason },
    })
    if (geoResult.denied) {
      return {
        ok: false,
        status: 403,
        code: "GEO_BLOCKED",
        error: "Sign-in is not allowed from your current location. Contact your administrator.",
      }
    }
    if (geoResult.bypassed) bypassed.push("geo")
  }

  if (exemptions.managedDevice) {
    bypassed.push("device")
  } else {
    const deviceResult = await enforceManagedDevice(input.tenantId, { ...common, assertion: input.deviceAssertion })
    if (deviceResult.denied) {
      return {
        ok: false,
        status: 403,
        code: "MANAGED_DEVICE_REQUIRED",
        error: "Sign-in requires a managed device. Enroll this device or contact your administrator.",
      }
    }
    if (deviceResult.bypassed) bypassed.push("device")
  }

  if (isPlatformAdminClass(platform.accountClass)) {
    await recordPlatformExemptionAudit(input, platform, exemptions)
  }

  return { ok: true, bypassed, emergency, platform }
}
