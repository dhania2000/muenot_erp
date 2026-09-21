/** Tenant settings are strings; this pure policy is shared by web and mobile login. */
export function requiresMfaByPolicy(input: { role: string; mfaEnabled: boolean; settings: Record<string, string> }) {
  if (input.mfaEnabled) return true
  if (input.settings["security.require_mfa"] === "true") return true
  return input.role === "admin" && input.settings["security.require_mfa_admins"] === "true"
}
