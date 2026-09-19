import "server-only"
/**
 * SPEC 37 — Environment / Configuration management.
 * ---------------------------------------------------------------------------
 * Phase 2 (the service), server orchestration. This is the single entry point
 * the rest of the app uses to READ effective configuration. It gathers the raw
 * layers — deployment env (process.env), the platform config store, and the
 * platform feature-flag store — and hands each descriptor to the pure resolver
 * (lib/config/resolve.ts) so precedence and secret-masking are applied in one
 * reviewed place.
 *
 * SCOPE SEPARATION: this reads platform + deployment layers only. Tenant-scoped
 * descriptors surface their default (or an env override) here so the platform
 * console can see the shape of tenant configuration WITHOUT reading any single
 * tenant's rows — the actual per-tenant value lives behind each tenant's own
 * admin settings and the tenant guard, never in the platform diagnostic.
 *
 * Defensive by design: a database that is unreachable (fresh preview) degrades
 * to env + defaults rather than throwing, mirroring the rest of the codebase.
 */

import { CONFIG_REGISTRY, getDescriptor, type ConfigCategory } from "./registry"
import {
  assertNoSecretExposure,
  resolveConfigValue,
  toPublicEntry,
  type ResolvedConfigEntry,
} from "./resolve"
import { listConfig, listFeatureFlags } from "@/lib/platform-console"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { getTenantSettingsMap } from "@/lib/tenant-settings"

/**
 * Build the map of platform-store values keyed exactly like the registry:
 * `platform_config.config_key` for config rows and `flag.<flag_key>` for flags.
 * Secrets from listConfig() arrive as null (the store already withholds them),
 * so a secret platform value only ever resolves from env or default here.
 */
async function loadPlatformValues(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const config = await listConfig()
    for (const row of config) {
      if (row.config_value != null) map.set(row.config_key, String(row.config_value))
    }
  } catch (err) {
    console.error("[v0] config service: platform config unavailable", err)
  }
  try {
    const flags = await listFeatureFlags()
    for (const f of flags) map.set(`flag.${f.key}`, f.enabled ? "enabled" : "disabled")
  } catch (err) {
    console.error("[v0] config service: feature flags unavailable", err)
  }
  return map
}

async function loadTenantValues(): Promise<Map<string, string>> {
  const tenantId = currentTenantIdOrNull()
  if (tenantId == null) return new Map()
  try {
    return new Map(Object.entries(await getTenantSettingsMap(tenantId)))
  } catch (err) {
    console.error("[v0] config service: tenant config unavailable", err)
    return new Map()
  }
}

/**
 * The effective, secret-safe configuration across every category. Safe to send
 * to any platform-staff surface: the result is asserted free of secret
 * plaintext before it is returned.
 */
export async function getEffectiveConfig(): Promise<ResolvedConfigEntry[]> {
  const platformValues = await loadPlatformValues()
  const tenantValues = await loadTenantValues()
  const entries = CONFIG_REGISTRY.map((d) => {
    const env = d.envVar ? process.env[d.envVar] : undefined
    const platform = d.scope === "platform" ? platformValues.get(d.key) : undefined
    const tenant = d.scope === "tenant" ? tenantValues.get(d.key) : undefined
    const raw = resolveConfigValue(d, { env, tenant, platform })
    return toPublicEntry(d, raw)
  })
  // Fail closed: never hand back a set that leaked a secret.
  assertNoSecretExposure(entries)
  return entries
}

/** The same effective config, grouped by category in registry order. */
export async function getEffectiveConfigByCategory(): Promise<
  { category: ConfigCategory; entries: ResolvedConfigEntry[] }[]
> {
  const entries = await getEffectiveConfig()
  const order: ConfigCategory[] = []
  const groups = new Map<ConfigCategory, ResolvedConfigEntry[]>()
  for (const e of entries) {
    if (!groups.has(e.category)) {
      groups.set(e.category, [])
      order.push(e.category)
    }
    groups.get(e.category)!.push(e)
  }
  return order.map((category) => ({ category, entries: groups.get(category)! }))
}

/**
 * Resolve a SINGLE value for server-side consumers. This MAY return a secret
 * plaintext and therefore must only be used on the server (never serialized to
 * a client). Unknown keys resolve to null.
 */
export async function getConfigValue(key: string): Promise<string | null> {
  const descriptor = getDescriptor(key)
  if (!descriptor) return null
  const env = descriptor.envVar ? process.env[descriptor.envVar] : undefined
  let platform: string | undefined
  let tenant: string | undefined
  if (descriptor.scope === "platform") {
    const values = await loadPlatformValues()
    platform = values.get(descriptor.key)
  }
  if (descriptor.scope === "tenant") {
    const values = await loadTenantValues()
    tenant = values.get(descriptor.key)
  }
  return resolveConfigValue(descriptor, { env, tenant, platform }).value
}
