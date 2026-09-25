/**
 * Tenant multi-factor-authentication policy.
 * ---------------------------------------------------------------------------
 * Pure and string-based so web login, mobile login and the settings editor
 * share exactly one decision. No `server-only`, no DB, no process.env — the
 * enforcement rules built on top can be unit-tested without a database.
 *
 * The policy is stored as tenant settings (see lib/config/registry.ts):
 *   security.mfa_mode                 disabled | optional | required_all |
 *                                     required_admins | required_roles
 *   security.mfa_grace_period_days    days a mandated user has to enrol
 *   security.mfa_required_roles       CSV of tenant roles (required_roles mode)
 *   security.mfa_exempted_users       CSV/newline list of exempt emails
 *   security.mfa_policy_effective_at  ISO timestamp the mandate started (the
 *                                     grace-period anchor, set server-side)
 *   security.mfa_allowed_methods      CSV of allowed factors (stored preference)
 *   security.mfa_recovery_policy      recovery-code policy (stored preference)
 */

export const MFA_MODES = [
  "disabled",
  "optional",
  "required_all",
  "required_admins",
  "required_roles",
] as const

export type MfaMode = (typeof MFA_MODES)[number]

/** Modes that make MFA mandatory for at least some users. */
export const MANDATORY_MFA_MODES: MfaMode[] = ["required_all", "required_admins", "required_roles"]

export const MFA_POLICY_KEYS = [
  "security.mfa_mode",
  "security.mfa_grace_period_days",
  "security.mfa_required_roles",
  "security.mfa_exempted_users",
  "security.mfa_policy_effective_at",
  "security.mfa_allowed_methods",
  "security.mfa_recovery_policy",
] as const

export const MFA_ROLES = ["tenant_owner", "tenant_admin", "module_admin", "employee"] as const
export const MFA_METHODS = ["totp", "backup_codes", "sms"] as const
export const MFA_RECOVERY_POLICIES = ["self_service", "admin_approval", "disabled"] as const

export type MfaPolicy = {
  mode: MfaMode
  gracePeriodDays: number
  requiredRoles: string[]
  exemptedEmails: string[]
  effectiveAt: Date | null
  allowedMethods: string[]
  recoveryPolicy: string
}

export function isMandatoryMode(mode: MfaMode): boolean {
  return MANDATORY_MFA_MODES.includes(mode)
}

function splitList(value: string | undefined | null): string[] {
  if (!value) return []
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Parse a settings map into a normalized policy. Legacy boolean keys
 * (security.require_mfa / security.require_mfa_admins) are honoured as a mode
 * fallback so tenants configured before the mode model keep working.
 */
export function parseMfaPolicy(settings: Record<string, string>): MfaPolicy {
  let mode = String(settings["security.mfa_mode"] ?? "").trim() as MfaMode
  if (!MFA_MODES.includes(mode)) {
    if (settings["security.require_mfa"] === "true") mode = "required_all"
    else if (settings["security.require_mfa_admins"] === "true") mode = "required_admins"
    else mode = "optional"
  }

  const graceRaw = Number(settings["security.mfa_grace_period_days"])
  const gracePeriodDays = Number.isFinite(graceRaw) && graceRaw > 0 ? Math.floor(graceRaw) : 0

  const effectiveRaw = settings["security.mfa_policy_effective_at"]
  const effectiveDate = effectiveRaw ? new Date(effectiveRaw) : null
  const effectiveAt = effectiveDate && !Number.isNaN(effectiveDate.getTime()) ? effectiveDate : null

  const allowedMethods = splitList(settings["security.mfa_allowed_methods"])

  return {
    mode,
    gracePeriodDays,
    requiredRoles: splitList(settings["security.mfa_required_roles"]),
    exemptedEmails: splitList(settings["security.mfa_exempted_users"]),
    effectiveAt,
    allowedMethods: allowedMethods.length ? allowedMethods : ["totp", "backup_codes"],
    recoveryPolicy: String(settings["security.mfa_recovery_policy"] ?? "self_service"),
  }
}

function normalizeTenantRole(input: { role: string; tenantRole?: string }): string {
  const tenantRole = (input.tenantRole ?? "").trim().toLowerCase()
  if (tenantRole) return tenantRole
  return input.role === "admin" ? "tenant_admin" : "employee"
}

function isAdminLike(input: { role: string; tenantRole?: string }): boolean {
  if (input.role === "admin") return true
  const tenantRole = normalizeTenantRole(input)
  return tenantRole === "tenant_owner" || tenantRole === "tenant_admin" || tenantRole === "module_admin"
}

/** Whether the policy makes MFA mandatory for this user's role (ignores grace/exemptions). */
export function mfaMandatedForRole(policy: MfaPolicy, input: { role: string; tenantRole?: string }): boolean {
  switch (policy.mode) {
    case "required_all":
      return true
    case "required_admins":
      return isAdminLike(input)
    case "required_roles":
      return policy.requiredRoles.includes(normalizeTenantRole(input))
    default:
      return false
  }
}

export type MfaEvaluation = {
  /** Policy targets this user's role. */
  mandated: boolean
  /** User is on the exemption list. */
  exempt: boolean
  /** Mandated + unenrolled + grace expired: block sign-in until enrolled. */
  enforcedNow: boolean
  /** Mandated + unenrolled but still inside the grace window. */
  inGrace: boolean
  /** When the grace window closes (null when not applicable). */
  graceEndsAt: Date | null
}

/**
 * Decide whether an unenrolled, mandated user must be blocked at sign-in.
 *
 * Enrolled users are always satisfied. Exempt users are never blocked. A
 * mandated, unenrolled user is allowed through during the grace window (the UI
 * should nudge them to enrol) and blocked once it closes. The grace window is
 * anchored on `effectiveAt` — the moment the mandate was switched on — so
 * turning the policy on never instantly locks out everyone. When no effective
 * date has been recorded yet, enforcement holds off (fail-open on enrolment)
 * rather than blocking on a policy that was never actually activated.
 */
export function evaluateMfaPolicy(input: {
  policy: MfaPolicy
  role: string
  tenantRole?: string
  email: string
  mfaEnabled: boolean
  now?: Date
}): MfaEvaluation {
  const now = input.now ?? new Date()
  const mandated = mfaMandatedForRole(input.policy, input)
  const exempt = input.email
    ? input.policy.exemptedEmails.includes(input.email.trim().toLowerCase())
    : false

  if (!mandated || exempt || input.mfaEnabled) {
    return { mandated, exempt, enforcedNow: false, inGrace: false, graceEndsAt: null }
  }

  if (!input.policy.effectiveAt) {
    // Mandate configured but never activated with an effective date: do not
    // block. The save path always stamps an effective date for mandatory modes.
    return { mandated, exempt, enforcedNow: false, inGrace: true, graceEndsAt: null }
  }

  const graceMs = input.policy.gracePeriodDays * 24 * 60 * 60 * 1000
  const graceEndsAt = new Date(input.policy.effectiveAt.getTime() + graceMs)
  const inGrace = now.getTime() < graceEndsAt.getTime()
  return { mandated, exempt, enforcedNow: !inGrace, inGrace, graceEndsAt }
}

/**
 * Backwards-compatible helper retained for callers that only need the
 * role-level "is MFA required?" decision (mobile login, existing tests).
 * Enrolled users are always challenged; otherwise the tenant policy decides.
 */
export function requiresMfaByPolicy(input: { role: string; mfaEnabled: boolean; settings: Record<string, string> }) {
  if (input.mfaEnabled) return true
  return mfaMandatedForRole(parseMfaPolicy(input.settings), { role: input.role })
}

/**
 * Whether tenant policy demands a *phishing-resistant* factor (a WebAuthn
 * security key / passkey) rather than accepting a TOTP code. Privileged roles
 * (tenant admins) can be held to this even when it is not required tenant-wide,
 * which is the "require phishing-resistant MFA for privileged roles" control.
 *
 * Pure and string-based so web and mobile login share one decision.
 */
export function requiresPhishingResistantMfa(input: { role: string; settings: Record<string, string> }): boolean {
  if (input.settings["security.require_webauthn"] === "true") return true
  return input.role === "admin" && input.settings["security.require_webauthn_admins"] === "true"
}
