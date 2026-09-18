import "server-only"
/**
 * SPEC 18 — Phase 3. Server-side FEATURE enforcement.
 * ---------------------------------------------------------------------------
 * The pure resolver (lib/platform/feature-entitlements.ts) decides a feature's
 * state from a plan; this module binds it to a real tenant and turns it into a
 * request-level gate. It is the enforcement point route handlers call so that a
 * feature is refused on the SERVER even when the client bypasses hidden UI and
 * posts directly to the API.
 *
 * Denial semantics mirror the SPEC 17 quota guard:
 *   • DISABLED feature  → 403 (the plan does not grant it at all).
 *   • LIMITED over cap  → 402 Payment Required (upgrade to raise the ceiling).
 *   • METERED           → always allowed; overage is reported, never blocked.
 */
import {
  getTenantEntitlements,
  getTenantUsage,
  type EntitlementResult,
} from "@/lib/platform/entitlement-guard"
import {
  getFeatureDef,
  resolveFeature,
  resolveAllFeatures,
  type FeatureResolution,
} from "@/lib/platform/feature-entitlements"
import type { QuotaKey } from "@/lib/platform/entitlements"

export type FeatureGateResult = EntitlementResult & { resolution?: FeatureResolution }

/**
 * Enforce a single feature for a tenant. Resolves the tenant's live usage of
 * the backing quota (unless an explicit override is supplied) and tests room
 * for `requested` new units.
 *
 *   ok:true  → the action may proceed (ENABLED, LIMITED-with-room, or METERED,
 *              even in overage). Inspect `resolution.overage` to decide billing.
 *   ok:false → refused; `status` is 403 (disabled) or 402 (limit reached).
 */
export async function enforceFeature(
  tenantId: number,
  featureKey: string,
  opts: { requested?: number; usage?: number } = {},
): Promise<FeatureGateResult> {
  const requested = opts.requested ?? 1
  const def = getFeatureDef(featureKey)
  const ent = await getTenantEntitlements(tenantId)

  if (!def) {
    // Fail closed: an unknown feature key is never silently permitted.
    return { ok: false, status: 403, reason: `Unknown feature "${featureKey}"` }
  }

  const usage =
    def.quota != null
      ? (opts.usage ?? (await getTenantUsage(tenantId, def.quota as QuotaKey)))
      : 0

  const resolution = resolveFeature(ent, def, usage, requested)

  if (resolution.available) return { ok: true, resolution }

  // Not available: distinguish "not granted" (403) from "cap reached" (402).
  const status: 402 | 403 = resolution.state === "limited" ? 402 : 403
  return {
    ok: false,
    status,
    reason: resolution.reason ?? "Feature not available on your plan",
    dimension: resolution.quota,
    limit: resolution.limit ?? undefined,
    usage: resolution.usage,
    resolution,
  }
}

/**
 * Resolve the tenant's entire feature map (state + live usage for capacity
 * features). Feeds a tenant-facing "what's on my plan" surface and is the same
 * truth the guard enforces — so the UI cannot advertise a feature the server
 * would refuse.
 */
export async function getTenantFeatureMap(tenantId: number): Promise<FeatureResolution[]> {
  const ent = await getTenantEntitlements(tenantId)
  // Collect live usage once per distinct quota the catalog references.
  const quotas = Array.from(
    new Set(
      resolveAllFeatures(ent)
        .map((f) => f.quota)
        .filter((q): q is QuotaKey => q != null),
    ),
  )
  const usageEntries = await Promise.all(
    quotas.map(async (q) => [q, await getTenantUsage(tenantId, q)] as const),
  )
  const usageByQuota = Object.fromEntries(usageEntries) as Partial<Record<QuotaKey, number>>
  return resolveAllFeatures(ent, usageByQuota)
}
