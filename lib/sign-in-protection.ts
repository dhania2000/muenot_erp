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

export type SignInProtectionResult =
  | { ok: true; bypassed: Array<"geo" | "device">; emergency: EmergencyAuthorization }
  | { ok: false; status: 403; code: "GEO_BLOCKED" | "MANAGED_DEVICE_REQUIRED"; error: string }

export async function enforceSignInProtection(input: SignInProtectionInput): Promise<SignInProtectionResult> {
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

  return { ok: true, bypassed, emergency }
}
