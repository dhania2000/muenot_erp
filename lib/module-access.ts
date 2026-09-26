import "server-only"
import { getSettings } from "@/lib/settings/server"
import type { SettingsMap } from "@/lib/settings/format"

/**
 * SPEC 45 — TENANT MODULE CONFIGURATION (server-side enforcement)
 * ---------------------------------------------------------------------------
 * Tenants can turn top-level modules on/off through `module.<slug>` settings
 * (see lib/company-settings-config.ts). The sidebar already hides a disabled
 * module (lib/workspace-nav.tsx), but hiding a link is NOT access control: the
 * module's pages and APIs stayed reachable by direct URL, so a disabled feature
 * was still exposed.
 *
 * This module is the single source of truth that closes that gap. The pure
 * `isModuleEnabledInSettings` decision is shared by:
 *   • page/layout guards  (assertModuleEnabled → notFound on the module subtree)
 *   • API route guards     (requireModuleEnabled → 404 fail-closed)
 *   • navigation building   (already gates via the same `module.<slug>` keys)
 *
 * Fail-closed only for KNOWN toggleable modules; anything not in the toggle set
 * (management, tasks, storage, billing, …) is always available so we never hide
 * a module a tenant has no switch for.
 */

/** Top-level modules a tenant can enable/disable. Mirrors the `module.*`
 * toggles declared in lib/company-settings-config.ts. Keep in sync with that
 * list — a slug not present here is treated as always-on. */
export const TOGGLEABLE_MODULES = [
  "hr",
  "finance",
  "sales",
  "recruitment",
  "operations",
  "tickets",
  "products",
  "legal",
] as const

export type ToggleableModule = (typeof TOGGLEABLE_MODULES)[number]

const TOGGLEABLE_SET = new Set<string>(TOGGLEABLE_MODULES)

/** Same truthy semantics used across settings (settings/server, workspace-nav). */
function truthy(v: string | undefined): boolean {
  if (v == null) return false
  const s = v.trim().toLowerCase()
  return s === "enabled" || s === "true" || s === "1" || s === "yes" || s === "on"
}

/**
 * Normalise a route slug to its module setting key, or null when the slug is
 * not a toggleable top-level module. Only the first path segment matters:
 * `finance/sales-invoices` and `finance` both map to `module.finance`.
 */
export function moduleSettingKey(slug: string): string | null {
  const base = String(slug ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .split(/[/?#]/)[0]
  if (!base || !TOGGLEABLE_SET.has(base)) return null
  return `module.${base}`
}

/**
 * Pure enablement decision over an already-loaded settings map. Defaults to
 * ENABLED when the tenant has never set the toggle, and returns true for any
 * non-toggleable slug (there is nothing to disable). Tenant isolation is a
 * property of the settings map passed in — two tenants pass two maps and never
 * share state here.
 */
export function isModuleEnabledInSettings(settings: SettingsMap, slug: string): boolean {
  const key = moduleSettingKey(slug)
  if (key == null) return true
  const v = settings[key]
  if (v == null || String(v).trim() === "") return true
  return truthy(v)
}

/**
 * Server: is `slug`'s module enabled for the CURRENT tenant? Reads the
 * tenant-scoped effective settings (getSettings is tenant-aware and cached).
 */
export async function isModuleEnabled(slug: string): Promise<boolean> {
  const settings = await getSettings()
  return isModuleEnabledInSettings(settings as SettingsMap, slug)
}

/**
 * Page/layout guard: 404 the whole module subtree when the tenant has disabled
 * it, so a disabled feature is neither shown nor reachable. `notFound()` is
 * imported lazily so this file stays free of next/navigation at module load
 * (keeps the pure helpers unit-testable under Vitest).
 */
export async function assertModuleEnabled(slug: string): Promise<void> {
  if (await isModuleEnabled(slug)) return
  const { notFound } = await import("next/navigation")
  notFound()
}

/**
 * API guard: true when the current tenant may call this module's API. Callers
 * fail closed with 404 (not 403) so a disabled module's API surface is not even
 * disclosed to exist — matching guardCompanyOps' non-disclosure convention.
 */
export async function requireModuleEnabled(slug: string): Promise<boolean> {
  return isModuleEnabled(slug)
}
