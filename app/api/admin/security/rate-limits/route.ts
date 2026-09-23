import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { getTenantById } from "@/lib/tenant-service"
import { listApiKeys } from "@/lib/api-keys-store"
import { getApiUsageSummary } from "@/lib/api-platform/audit"
import {
  PLAN_RATE_LIMITS,
  DEFAULT_RATE_LIMIT_TIER,
  resolveTierForPlan,
  type RateLimitTier,
  type RateWindowKey,
} from "@/lib/api-platform/rate-limit-engine"
import { snapshotSharedRateLimits } from "@/lib/api-platform/rate-limit-store"
import { createRatePolicy, listRatePolicies, RatePolicyError } from "@/lib/api-platform/rate-limit-policies"

export const dynamic = "force-dynamic"

const WINDOW_ORDER: RateWindowKey[] = ["second", "minute", "hour", "day"]

async function requireAdminTenant() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return null
  const tenantId = effectiveTenantId(guard.ctx)
  return tenantId ? { userId: guard.ctx.userId, tenantId } : null
}

/**
 * SPEC 53 — Real, read-only view of the ENFORCED rate-limit configuration and
 * live usage for the public `/api/v1/*` surface. Limits are plan-derived and
 * applied on every request by lib/api-platform/handler.ts (not a preview):
 * this endpoint reports the tenant's effective tier, the per-plan reference
 * table, the shared counters for the tenant's own API keys, and the
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
  const policies = await listRatePolicies(ctx.tenantId)
  const keyById = new Map(keys.map((k) => [k.id, k]))
  const shared = await snapshotSharedRateLimits(ctx.tenantId, keys.map(key => key.id))
  const liveScopes = shared.filter(s => s.windows.some(window => window.used > 0))
    .map((s) => {
      const keyId = s.keyId
      const key = keyById.get(keyId)
      const windows = WINDOW_ORDER.map((w) => {
        const found = s.windows.find((x) => x.name === w)
        const used = found?.used ?? 0
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
        scope: `apiv1:key:${keyId}`,
        keyId,
        keyName: key?.name ?? `Key #${keyId}`,
        environment: key?.environment ?? null,
        blocked: windows.some(window => window.used >= window.limit),
        blockedUntil: windows.filter(window => window.used >= window.limit && window.resetAt).map(window => window.resetAt!)[0] ?? null,
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
    apiKeys: keys.map(key => ({ id: key.id, name: key.name })),
    policies,
    liveScopes,
    usage,
  })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const value: unknown = await request.json()
    const policy = await createRatePolicy(ctx.tenantId, value, ctx.userId)
    return NextResponse.json({ policy }, { status: 201 })
  } catch (error) {
    if (error instanceof RatePolicyError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    return NextResponse.json({ error: "Unable to create policy" }, { status: 500 })
  }
}
