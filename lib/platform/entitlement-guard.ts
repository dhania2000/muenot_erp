import "server-only"
/**
 * SPEC 17 — Phase 4. Entitlement ENFORCEMENT.
 * ---------------------------------------------------------------------------
 * Phase 1 defined the contract (lib/platform/entitlements.ts), Phases 2/3 store
 * and edit it (lib/platform-console.ts + the Super Admin plan manager). This
 * module is where the contract actually bites: it resolves the EFFECTIVE
 * entitlements for a tenant (its subscription's plan) and turns the pure
 * predicates into request-level gates route handlers can call.
 *
 * Two kinds of gate:
 *   • CAPABILITY gates (module / feature flag / report tier) — a hard yes/no.
 *     Denials are 403 (the plan does not grant the capability at all).
 *   • QUOTA gates (users, employees, storage, API, automations, jobs, AI,
 *     integrations) — "is there room for N more?". Denials are 402 Payment
 *     Required, the semantically correct "upgrade your plan" signal.
 *
 * Usage is resolved defensively: a dimension backed by a real tenant-scoped
 * table is counted live; a dimension with no countable source reports 0 so the
 * quota still governs new allocations without ever crashing a request.
 */
import { query, tableColumns } from "@/lib/db"
import { getSubscriptionForTenant } from "@/lib/platform-console"
import {
  type PlanEntitlements,
  type QuotaKey,
  type ReportLevel,
  type LimitCheck,
  QUOTA_KEYS,
  checkQuota,
  hasModule,
  hasFeatureFlag,
  meetsReportLevel,
  parseEntitlements,
  presetForCode,
} from "@/lib/platform/entitlements"

// ---------------------------------------------------------------------------
// Effective entitlement resolution
// ---------------------------------------------------------------------------

/**
 * The entitlement contract in force for a tenant right now. Resolution order:
 *   1. The tenant's subscription plan_code → that plan's stored entitlements.
 *   2. If the plan row predates SPEC 17 (NULL entitlements) → the tier preset.
 *   3. If the tenant has no subscription yet → the "starter" preset floor.
 * A canceled subscription grants nothing beyond the plan's own contract here;
 * status-based lockout is a separate concern (subscription lifecycle).
 */
export async function getTenantEntitlements(tenantId: number): Promise<PlanEntitlements> {
  const sub = await getSubscriptionForTenant(tenantId)
  const code = sub?.plan_code ?? "starter"
  const rows = await query<{ entitlements: string | null; code: string }[]>(
    "SELECT `code`, `entitlements` FROM `platform_plans` WHERE `code` = ? LIMIT 1",
    [code],
  )
  const row = rows[0]
  if (!row) return presetForCode(code)
  return row.entitlements != null ? parseEntitlements(row.entitlements) : presetForCode(row.code)
}

// ---------------------------------------------------------------------------
// Usage resolution (defensive, real-data-first)
// ---------------------------------------------------------------------------

/**
 * Candidate tenant-scoped source table for each countable quota dimension. A
 * dimension is counted only when the table AND a `tenant_id` column both exist;
 * otherwise it reports 0. Metered dimensions (storage, API, AI, jobs) have no
 * row-count source — their live usage comes from the metering pipeline, so they
 * default to 0 here and callers may pass an explicit usage override.
 */
const USAGE_SOURCE: Partial<Record<QuotaKey, string>> = {
  users: "users",
  employees: "employees",
  integrations: "integrations",
  automations: "automation_workflows",
}

async function countTenantRows(table: string, tenantId: number): Promise<number> {
  try {
    const cols = await tableColumns(table)
    if (cols.size === 0 || !cols.has("tenant_id")) return 0
    const rows = await query<{ c: number | string }[]>(
      `SELECT COUNT(*) AS c FROM \`${table}\` WHERE \`tenant_id\` = ?`,
      [tenantId],
    )
    return Math.max(0, Math.floor(Number(rows?.[0]?.c ?? 0)))
  } catch {
    // A missing table / column must never break an enforcement decision.
    return 0
  }
}

/** Current usage for one quota dimension (0 when there is no countable source). */
export async function getTenantUsage(tenantId: number, dimension: QuotaKey): Promise<number> {
  const table = USAGE_SOURCE[dimension]
  if (!table) return 0
  return countTenantRows(table, tenantId)
}

/** Current usage across every quota dimension, keyed by dimension. */
export async function getTenantUsageAll(tenantId: number): Promise<Record<QuotaKey, number>> {
  const entries = await Promise.all(
    QUOTA_KEYS.map(async (k) => [k, await getTenantUsage(tenantId, k)] as const),
  )
  return Object.fromEntries(entries) as Record<QuotaKey, number>
}

// ---------------------------------------------------------------------------
// Gate results
// ---------------------------------------------------------------------------

export type EntitlementOk = { ok: true }
export type EntitlementDenied = {
  ok: false
  /** 403 = plan does not grant the capability; 402 = quota exceeded (upgrade). */
  status: 402 | 403
  reason: string
  dimension?: QuotaKey
  limit?: number | null
  usage?: number
}
export type EntitlementResult = EntitlementOk | EntitlementDenied

const ok: EntitlementOk = { ok: true }

// ---------------------------------------------------------------------------
// Capability gates (403 on denial)
// ---------------------------------------------------------------------------

export async function requireModule(tenantId: number, moduleKey: string): Promise<EntitlementResult> {
  const ent = await getTenantEntitlements(tenantId)
  if (hasModule(ent, moduleKey)) return ok
  return { ok: false, status: 403, reason: `Your plan does not include the "${moduleKey}" module` }
}

export async function requireFeatureFlag(tenantId: number, flagKey: string): Promise<EntitlementResult> {
  const ent = await getTenantEntitlements(tenantId)
  if (hasFeatureFlag(ent, flagKey)) return ok
  return { ok: false, status: 403, reason: `Feature "${flagKey}" is not enabled on your plan` }
}

export async function requireReportLevel(
  tenantId: number,
  required: ReportLevel,
): Promise<EntitlementResult> {
  const ent = await getTenantEntitlements(tenantId)
  if (meetsReportLevel(ent, required)) return ok
  return { ok: false, status: 403, reason: `Your plan's reporting tier does not include "${required}" reports` }
}

// ---------------------------------------------------------------------------
// Quota gate (402 on denial)
// ---------------------------------------------------------------------------

/**
 * Is there room for `requested` more units of `dimension`? Resolves live usage
 * (unless an explicit `currentUsage` override is supplied — useful for metered
 * dimensions the caller already knows), then applies the pure quota check.
 */
export async function requireQuota(
  tenantId: number,
  dimension: QuotaKey,
  requested = 1,
  currentUsage?: number,
): Promise<EntitlementResult & { check?: LimitCheck }> {
  const ent = await getTenantEntitlements(tenantId)
  const usage = currentUsage ?? (await getTenantUsage(tenantId, dimension))
  const check = checkQuota(ent, dimension, usage, requested)
  if (check.allowed) return { ...ok, check }
  return {
    ok: false,
    status: 402,
    reason: check.unlimited
      ? "Quota exceeded"
      : `Plan limit reached for ${dimension.replace(/_/g, " ")} (${check.usage}/${check.limit})`,
    dimension,
    limit: check.limit,
    usage: check.usage,
    check,
  }
}

// ---------------------------------------------------------------------------
// Snapshot — entitlements + usage + per-dimension check (for tenant plan UI)
// ---------------------------------------------------------------------------

export type EntitlementSnapshot = {
  entitlements: PlanEntitlements
  usage: Record<QuotaKey, number>
  quotas: Record<QuotaKey, LimitCheck>
}

/** Everything a tenant-facing "plan & usage" view needs in one resolved shot. */
export async function getEntitlementSnapshot(tenantId: number): Promise<EntitlementSnapshot> {
  const [ent, usage] = await Promise.all([
    getTenantEntitlements(tenantId),
    getTenantUsageAll(tenantId),
  ])
  const quotas = Object.fromEntries(
    QUOTA_KEYS.map((k) => [k, checkQuota(ent, k, usage[k], 0)]),
  ) as Record<QuotaKey, LimitCheck>
  return { entitlements: ent, usage, quotas }
}
