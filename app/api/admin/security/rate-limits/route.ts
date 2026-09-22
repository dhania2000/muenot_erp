import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getTenantById } from "@/lib/tenant-service"
import { listApiKeys } from "@/lib/api-keys-store"
import { getApiUsageSummary } from "@/lib/api-platform/audit"
import {
  PLAN_RATE_LIMITS,
  DEFAULT_RATE_LIMIT_TIER,
  resolveTierForPlan,
  snapshotRateLimits,
  type RateLimitTier,
  type RateWindowKey,
} from "@/lib/api-platform/rate-limit-engine"

export const dynamic = "force-dynamic"

const WINDOW_ORDER: RateWindowKey[] = ["second", "minute", "hour", "day"]

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

/**
 * SPEC 53 — Real, read-only view of the ENFORCED rate-limit configuration and
 * live usage for the public `/api/v1/*` surface. Limits are plan-derived and
 * applied on every request by lib/api-platform/handler.ts (not a preview):
 * this endpoint reports the tenant's effective tier, the per-plan reference
 * table, the live in-process counters for the tenant's own API keys, and the
 * blocked-request (429) count sourced from the request audit trail.
 */
export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  let plan: string | null = null
  try {
    plan = (await getTenantById(ctx.tenantId))?.plan ?? null
  } catch {
    plan = null
  }
  const effectiveTier = resolveTierForPlan(plan)

  // Scopes are keyed `apiv1:key:{keyId}`; only surface counters for keys that
  // belong to this tenant so one admin never sees another tenant's usage.
  const keys = await listApiKeys(ctx.tenantId)
  const keyById = new Map(keys.map((k) => [k.id, k]))
  const ownedScopes = new Set(keys.map((k) => `apiv1:key:${k.id}`))

  const now = Date.now()
  const liveScopes = snapshotRateLimits()
    .filter((s) => ownedScopes.has(s.scope))
    .map((s) => {
      const keyId = Number(s.scope.split(":").pop())
      const key = keyById.get(keyId)
      const windows = WINDOW_ORDER.map((w) => {
        const found = s.windows.find((x) => x.window === w)
        const used = found?.count ?? 0
        const limit = effectiveTier[w]
        return {
          window: w,
          used,
          limit,
          remaining: Math.max(0, limit - used),
          resetAt: found ? Math.ceil(found.resetAt / 1000) : null,
        }
      })
      return {
        scope: s.scope,
        keyId,
        keyName: key?.name ?? `Key #${keyId}`,
        environment: key?.environment ?? null,
        blocked: s.blockedUntil != null,
        blockedUntil: s.blockedUntil ? Math.ceil(s.blockedUntil / 1000) : null,
        windows,
      }
    })

  let usage = { totalRequests: 0, rateLimitedRequests: 0, requestsLast24h: 0, requestsLastHour: 0 }
  try {
    const summary = await getApiUsageSummary(ctx.tenantId)
    usage = {
      totalRequests: summary.totalRequests,
      rateLimitedRequests: summary.rateLimitedRequests,
      requestsLast24h: summary.requestsLast24h,
      requestsLastHour: summary.requestsLastHour,
    }
  } catch {
    // best-effort — usage telemetry unavailable
  }

  const plans = Object.entries(PLAN_RATE_LIMITS).map(([name, tier]) => ({ plan: name, tier }))

  return NextResponse.json({
    enforced: true,
    plan: plan ?? "default",
    effectiveTier: effectiveTier as RateLimitTier,
    defaultTier: DEFAULT_RATE_LIMIT_TIER,
    plans,
    apiKeyCount: keys.length,
    liveScopes,
    usage,
  })
}
