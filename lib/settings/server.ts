import "server-only"
import { cache } from "react"
import { query } from "@/lib/db"
import { companySettingsSections, getSectionDefaults } from "@/lib/company-settings-config"
import type { SettingsMap } from "@/lib/settings/format"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { getTenantSettingsMap } from "@/lib/tenant-settings"

// Keys that must never leave the server in plain text.
const SECRET_KEYS = new Set(
  companySettingsSections.flatMap((s) => s.fields.filter((f) => f.secret).map((f) => f.key)),
)

// Display-relevant, non-secret settings safe to hydrate on the client.
const PUBLIC_PREFIXES = [
  "company.",
  "app.",
  "currency.",
  "theme.",
  "language.",
  "module.",
  "customlink.",
  "whitelabel.",
  "message.",
  "notify.",
  "gdpr.enabled",
  "gdpr.cookie_consent",
  "gdpr.consent_text",
  "signup.enabled",
  "social.google_enabled",
  "social.linkedin_enabled",
  "social.facebook_enabled",
  "address.tax_name",
  "address.tax_number",
]

// Short cross-request cache so many consumers in one render don't re-query.
const memo = new Map<string, { at: number; data: SettingsMap }>()
const TTL_MS = 10_000

async function load(): Promise<SettingsMap> {
  const defaults = getSectionDefaults()
  const tenantId = currentTenantIdOrNull()
  const merged: SettingsMap = { ...defaults }
  try {
    const rows = await query<any[]>("SELECT skey, svalue FROM company_settings")
    for (const r of rows) {
      if (r.svalue != null && String(r.svalue) !== "") merged[r.skey] = String(r.svalue)
    }
  } catch {
    // A fresh install may not have the legacy table yet. Tenant overrides can
    // still be loaded independently below.
  }
  // Legacy global values remain the inherited baseline during migration;
  // tenant overrides always win and are loaded through the isolated store.
  if (tenantId != null) {
    try {
      const tenantValues = await getTenantSettingsMap(tenantId)
      Object.assign(merged, tenantValues)
    } catch {
      // DB not configured yet (e.g. fresh preview) — keep defaults/baseline.
    }
  }
  return merged
}

/**
 * Returns all effective settings (saved values merged over section defaults).
 * Deduplicated per-request via react cache() and reused across requests for a
 * short TTL to avoid hammering the database.
 */
export const getSettings = cache(async (): Promise<SettingsMap> => {
  const now = Date.now()
  const tenantId = currentTenantIdOrNull()
  const cacheKey = tenantId == null ? "global" : `tenant:${tenantId}`
  const cached = memo.get(cacheKey)
  if (cached && now - cached.at < TTL_MS) return cached.data
  const data = await load()
  memo.set(cacheKey, { at: now, data })
  return data
})

/** Force the next getSettings() call to re-read from the database. */
export function invalidateSettingsCache(tenantId?: number | null) {
  if (tenantId == null) memo.clear()
  else memo.delete(`tenant:${tenantId}`)
}

function truthy(v?: string) {
  if (v == null) return false
  const s = v.trim().toLowerCase()
  return s === "enabled" || s === "true" || s === "1" || s === "yes" || s === "on"
}

export async function getSetting(key: string): Promise<string> {
  return (await getSettings())[key] ?? ""
}

export async function getBool(key: string, fallback = false): Promise<boolean> {
  const v = (await getSettings())[key]
  return v == null ? fallback : truthy(v)
}

export async function getNum(key: string, fallback = 0): Promise<number> {
  const v = Number((await getSettings())[key])
  return Number.isFinite(v) ? v : fallback
}

/** Whether a top-level module (hr, finance, sales, ...) is enabled. Defaults on. */
export async function isModuleEnabled(name: string): Promise<boolean> {
  const key = `module.${name.toLowerCase()}`
  const s = await getSettings()
  return key in s ? truthy(s[key]) : true
}

/**
 * Persists a single global (non-tenant-scoped) key/value into
 * company_settings and invalidates the in-process cache so the next read
 * picks it up immediately. Used for simple admin toggles that aren't part of
 * the tenant-settings override system (e.g. security.ip_allowlist_enabled).
 */
export async function setGlobalSetting(key: string, value: string): Promise<void> {
  await query(`INSERT INTO company_settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue = ?`, [
    key,
    value,
    value,
  ])
  invalidateSettingsCache()
}

export async function setBool(key: string, value: boolean): Promise<void> {
  await setGlobalSetting(key, value ? "true" : "false")
}

/** Non-secret, display-relevant subset for client hydration. */
export async function getPublicSettings(): Promise<SettingsMap> {
  const all = await getSettings()
  const out: SettingsMap = {}
  for (const [k, v] of Object.entries(all)) {
    if (SECRET_KEYS.has(k)) continue
    if (PUBLIC_PREFIXES.some((p) => k.startsWith(p))) out[k] = v
  }
  return out
}
