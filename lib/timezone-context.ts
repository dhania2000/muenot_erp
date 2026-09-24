import "server-only"

/**
 * SPEC 158 — server-side timezone resolution.
 *
 * One place for request-handling code to answer "which zone should this instant
 * be presented/evaluated in?" given the layers it happens to have. It reads the
 * tenant's configured zone from the settings store and lets the caller supply
 * any of the more-specific layers (user / entity / job / report). The precedence
 * itself lives in the pure engine (`resolveTimeZone`), so it stays unit-tested.
 */

import { getSetting } from "@/lib/settings/server"
import {
  DEFAULT_TIME_ZONE,
  resolveTimeZone,
  type ResolvedTimeZone,
  type TimeZoneLayers,
} from "@/lib/timezone"

/** The tenant's configured `app.timezone`, or null when unset/invalid. */
export async function getTenantTimeZone(): Promise<string | null> {
  const value = await getSetting("app.timezone")
  return value ? String(value) : null
}

export type ResolveContextInput = Omit<TimeZoneLayers, "tenant">

/**
 * Resolve the effective timezone for the current tenant, layering any explicit
 * user/entity/job/report zone on top of the tenant setting. Falls back to the
 * ERP home zone when nothing valid is provided.
 */
export async function resolveTenantTimeZone(input: ResolveContextInput = {}): Promise<ResolvedTimeZone> {
  const tenant = await getTenantTimeZone()
  return resolveTimeZone({ ...input, tenant }, DEFAULT_TIME_ZONE)
}
