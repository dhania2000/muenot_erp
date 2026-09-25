/**
 * Platform-admin security policy — pure, testable core.
 * ---------------------------------------------------------------------------
 * Separates PLATFORM-level security-policy evaluation from TENANT-level
 * managed-device / geo policy, with an explicit, non-negotiable precedence:
 *
 *     PLATFORM_EMERGENCY   (break-glass platform admin)
 *            ↓
 *     PLATFORM_ADMIN       (platform super admin)
 *            ↓
 *     TENANT               (tenant-owned managed-device / geo / access policy)
 *            ↓
 *     USER
 *
 * A tenant-owned control (e.g. "require a managed device") must NEVER be able to
 * lock out a genuine Muenot platform administrator or an emergency break-glass
 * recovery account. That is the core fix: the tenant managed-device requirement
 * is skipped for platform admins UNCONDITIONALLY, not gated on any
 * tenant-controlled flag.
 *
 * IMPORTANT: whether an account IS a platform admin / break-glass admin is
 * resolved from AUTHORITATIVE SERVER-SIDE STATE (RBAC + trusted platform
 * configuration) by the callers — the functions here only classify inputs that
 * were already established server-side. They deliberately take no request body,
 * cookie, query, or token-controlled value, so a forged `role=SUPER_ADMIN`
 * cannot reach a bypass.
 *
 * DB-free and no `server-only` import, so every decision is unit-testable
 * directly. Only a type-only import from the (also DB-free) role model.
 */
import type { PlatformRole } from "@/lib/role-model"

export type PlatformAccountClass = "normal" | "platform_super_admin" | "break_glass_platform_admin"

export type SecurityPolicyLevel = "platform_emergency" | "platform_admin" | "tenant" | "user"

/**
 * Classify the acting account from already-trusted, server-resolved inputs.
 * Precedence: a break-glass recovery account is classified as emergency even if
 * it also holds the super-admin role, so it is never downgraded to the ordinary
 * platform-admin path.
 */
export function classifyPlatformAccount(input: {
  platformRole: PlatformRole | string | null | undefined
  isBreakGlassPlatformAdmin: boolean
}): PlatformAccountClass {
  if (input.isBreakGlassPlatformAdmin) return "break_glass_platform_admin"
  if (input.platformRole === "platform_super_admin") return "platform_super_admin"
  return "normal"
}

/** Map an account class to the security-policy level that governs it. */
export function securityPolicyLevelFor(cls: PlatformAccountClass): SecurityPolicyLevel {
  switch (cls) {
    case "break_glass_platform_admin":
      return "platform_emergency"
    case "platform_super_admin":
      return "platform_admin"
    default:
      return "tenant"
  }
}

/** True when the account operates the platform (super admin or break-glass). */
export function isPlatformAdminClass(cls: PlatformAccountClass): boolean {
  return cls === "platform_super_admin" || cls === "break_glass_platform_admin"
}

/**
 * Whether the account is exempt from TENANT-owned managed-device enforcement.
 * Only platform admins / break-glass admins are exempt — a normal user,
 * INCLUDING a tenant_admin / tenant_owner, is never exempt and continues to
 * follow their tenant's managed-device policy.
 */
export function isExemptFromTenantDevicePolicy(cls: PlatformAccountClass): boolean {
  return isPlatformAdminClass(cls)
}

/**
 * Which TENANT-owned controls are skipped for an account class. Precedence is
 * encoded here once so the login route and sign-in protection cannot drift:
 *
 *   - normal (incl. tenant admins): nothing skipped.
 *   - platform_super_admin: ONLY the tenant managed-device requirement. Geo,
 *     access-policy, IP allowlist and tenant MFA still apply (with their own
 *     existing, audited emergency paths) — "exempt from managed device" is not
 *     "exempt from all security".
 *   - break_glass_platform_admin: every tenant control that could cause a
 *     platform lockout (device, geo, IP allowlist, access-policy deny, tenant
 *     MFA / security-key ENROLLMENT blocks). An enrolled MFA factor is still
 *     challenged by the platform policy.
 */
export type TenantPolicyExemptions = {
  managedDevice: boolean
  geo: boolean
  ipAllowlist: boolean
  accessPolicyDeny: boolean
  tenantMfaEnrollment: boolean
  tenantPhishingResistantMfa: boolean
}

export function tenantPolicyExemptionsFor(cls: PlatformAccountClass): TenantPolicyExemptions {
  const breakGlass = cls === "break_glass_platform_admin"
  return {
    managedDevice: isExemptFromTenantDevicePolicy(cls),
    geo: breakGlass,
    ipAllowlist: breakGlass,
    accessPolicyDeny: breakGlass,
    tenantMfaEnrollment: breakGlass,
    tenantPhishingResistantMfa: breakGlass,
  }
}

/**
 * Dedicated platform-admin security settings. Sourced ONLY from platform
 * deployment configuration (env), never from tenant settings, so no tenant
 * admin can weaken or disable them.
 *
 *   PLATFORM_ADMIN_REQUIRE_MFA                     "true" ⇒ super admins must use MFA
 *   PLATFORM_ADMIN_REQUIRE_PHISHING_RESISTANT_MFA  "true" ⇒ super admins must use a security key
 *   PLATFORM_ADMIN_SESSION_TIMEOUT_MINUTES         cap on platform-admin session lifetime
 *
 * MFA defaults to OFF-by-mandate (an enrolled factor is still always challenged)
 * so switching this policy on can never lock out an un-enrolled operator before
 * a break-glass account exists. Enable it once recovery is verified.
 */
export type PlatformAdminSecurityPolicy = {
  requireMfa: boolean
  requirePhishingResistantMfa: boolean
  sessionTimeoutMinutes: number | null
}

export function parsePlatformAdminSecurityPolicy(
  env: Record<string, string | undefined>,
): PlatformAdminSecurityPolicy {
  const flag = (v: string | undefined) => String(v ?? "").trim().toLowerCase() === "true"
  const timeout = Number(env.PLATFORM_ADMIN_SESSION_TIMEOUT_MINUTES)
  return {
    requireMfa: flag(env.PLATFORM_ADMIN_REQUIRE_MFA),
    requirePhishingResistantMfa: flag(env.PLATFORM_ADMIN_REQUIRE_PHISHING_RESISTANT_MFA),
    sessionTimeoutMinutes: Number.isFinite(timeout) && timeout >= 1 ? Math.floor(timeout) : null,
  }
}

/** Session lifetime for the account: platform admins are capped by the platform policy. */
export function effectiveSessionMinutes(
  cls: PlatformAccountClass,
  tenantMinutes: number,
  policy: PlatformAdminSecurityPolicy,
): number {
  if (!isPlatformAdminClass(cls) || policy.sessionTimeoutMinutes == null) return tenantMinutes
  return Math.min(tenantMinutes, policy.sessionTimeoutMinutes)
}

/**
 * Parse the trusted platform break-glass allow-list from configuration (the
 * `PLATFORM_BREAK_GLASS_USER_IDS` env var). Accepts comma / whitespace / newline
 * separated positive integer user ids; ignores everything else. Because this
 * comes only from platform-level configuration, a tenant admin can never create,
 * grant, or modify break-glass status.
 */
export function parseBreakGlassPlatformAdminIds(raw: string | null | undefined): number[] {
  if (!raw) return []
  return Array.from(
    new Set(
      String(raw)
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  )
}

/**
 * Whether `userId` is a trusted break-glass platform admin per platform config.
 * `rawConfig` is the raw env value (passed in by the server caller) so this stays
 * pure and testable. Never reads request-controlled input.
 */
export function isBreakGlassPlatformAdmin(userId: number, rawConfig: string | null | undefined): boolean {
  return parseBreakGlassPlatformAdminIds(rawConfig).includes(Number(userId))
}

export type PlatformAdminAuthDecision = {
  allowed: boolean
  code?: "MFA_ENROLLMENT_REQUIRED" | "MFA_REQUIRED"
  reason?: string
}

/**
 * The dedicated platform strong-auth (MFA) decision, applied AFTER a platform
 * admin has been exempted from the tenant device policy. "Exempt from managed
 * device" must never mean "exempt from all security".
 *
 *   - platform_super_admin: the platform policy MAY require MFA. Unenrolled ⇒
 *     enrollment required; enrolled ⇒ must pass a challenge.
 *   - break_glass_platform_admin: challenged if MFA is enrolled, but NEVER hard-
 *     blocked on enrollment — a recovery account must still be able to get in
 *     when MFA itself is the broken control. This is the fail-safe recovery path.
 *   - normal: not decided here (the tenant MFA policy in the login route governs).
 */
export function evaluatePlatformAdminAuth(input: {
  accountClass: PlatformAccountClass
  requireMfa: boolean
  mfaEnabled: boolean
  mfaVerified: boolean
}): PlatformAdminAuthDecision {
  if (input.accountClass === "normal") return { allowed: true }

  if (input.accountClass === "break_glass_platform_admin") {
    if (input.mfaEnabled && !input.mfaVerified) {
      return { allowed: false, code: "MFA_REQUIRED", reason: "break_glass_mfa_challenge" }
    }
    return { allowed: true }
  }

  // platform_super_admin
  if (!input.requireMfa) return { allowed: true }
  if (!input.mfaEnabled) {
    return { allowed: false, code: "MFA_ENROLLMENT_REQUIRED", reason: "platform_admin_mfa_enrollment" }
  }
  if (!input.mfaVerified) {
    return { allowed: false, code: "MFA_REQUIRED", reason: "platform_admin_mfa_challenge" }
  }
  return { allowed: true }
}
