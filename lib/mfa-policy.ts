/** Tenant settings are strings; this pure policy is shared by web and mobile login. */
export function requiresMfaByPolicy(input: { role: string; mfaEnabled: boolean; settings: Record<string, string> }) {
  if (input.mfaEnabled) return true
  if (input.settings["security.require_mfa"] === "true") return true
  return input.role === "admin" && input.settings["security.require_mfa_admins"] === "true"
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
