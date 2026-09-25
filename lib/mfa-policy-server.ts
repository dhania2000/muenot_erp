import "server-only"
import { getDescriptor } from "@/lib/config/registry"
import { getTenantSettingsMap } from "@/lib/tenant-settings"
import { MFA_POLICY_KEYS, parseMfaPolicy, type MfaPolicy } from "@/lib/mfa-policy"

/**
 * Resolve the effective MFA policy for a tenant.
 *
 * The policy lives in tenant settings and is deliberately NOT part of
 * getPublicSettings() (which strips every `security.*` key), so login must read
 * it here with an explicit tenant id — never from client input. Registry
 * defaults form the baseline; the tenant's own overrides win. A missing tenant
 * (or an unavailable database on a fresh preview) resolves to the safe default
 * policy (optional / no enforcement) rather than throwing during sign-in.
 */
export async function loadMfaPolicyForTenant(tenantId: number | null | undefined): Promise<MfaPolicy> {
  const settings: Record<string, string> = {}
  for (const key of MFA_POLICY_KEYS) {
    const descriptor = getDescriptor(key)
    if (descriptor?.default != null) settings[key] = descriptor.default
  }

  if (tenantId != null) {
    try {
      const overrides = await getTenantSettingsMap(tenantId)
      for (const key of MFA_POLICY_KEYS) {
        if (overrides[key] != null && overrides[key] !== "") settings[key] = overrides[key]
      }
    } catch {
      // DB not configured yet (fresh preview) — fall back to registry defaults.
    }
  }

  return parseMfaPolicy(settings)
}
