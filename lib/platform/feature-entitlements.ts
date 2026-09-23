/**
 * Phases 1 & 2. FEATURE-LEVEL entitlements.
 * ---------------------------------------------------------------------------
 * modelled the plan CONTRACT (modules, quotas, flags, tiers).
 * projects that contract onto the concrete FEATURES a tenant actually touches
 * and resolves each into one of four canonical states:
 *
 *   • ENABLED  — fully available, no ceiling (boolean grant, or a "limited"
 *                feature whose quota is unlimited).
 *   • DISABLED — not available at all (module not in plan, a required flag/
 *                report tier missing, or a zero allowance). UI must hide it AND
 *                the server must refuse it.
 *   • LIMITED  — available up to a finite numeric ceiling (a quota). Each new
 *                unit is admitted only while usage stays within the cap.
 *   • METERED  — always usable, but consumption is measured against a quota;
 *                exceeding the cap is OVERAGE (billable), never a hard block.
 *
 * This module is PURE — no DB, no framework. It is the single source of truth
 * both the server guard (lib/platform/feature-guard.ts) and the UI read from,
 * so "what the button shows" and "what the API allows" can never drift apart.
 */

import {
  type PlanEntitlements,
  type QuotaKey,
  type ModuleKey,
  type ReportLevel,
  type Quota,
  checkQuota,
  hasModule,
  hasFeatureFlag,
  isUnlimited,
  meetsReportLevel,
} from "@/lib/platform/entitlements"

// ---------------------------------------------------------------------------
// The four canonical feature states.
// ---------------------------------------------------------------------------

export const FEATURE_STATES = ["enabled", "disabled", "limited", "metered"] as const
export type FeatureState = (typeof FEATURE_STATES)[number]

/**
 * How a feature draws its entitlement from the plan:
 *   • boolean — an on/off capability (optionally gated by a flag or report tier).
 *   • limited — capacity-bound; admits units up to a finite quota, ENABLED when
 *               the quota is unlimited.
 *   • metered — usage-measured; billable overage past the quota, never blocked.
 */
export type FeatureKind = "boolean" | "limited" | "metered"

export type FeatureDef = {
  key: string
  label: string
  module: ModuleKey
  kind: FeatureKind
  /** Quota dimension backing a limited/metered feature. */
  quota?: QuotaKey
  /** Optional feature flag a boolean capability additionally requires. */
  flag?: string
  /** Optional minimum report tier a boolean capability additionally requires. */
  requiresReport?: ReportLevel
  description?: string
}

// ---------------------------------------------------------------------------
// Phase 1 — the FEATURE CATALOG (inventory of gated features).
// ---------------------------------------------------------------------------
// Keys are stable, namespaced identifiers. Each maps onto a plan module and,
// where capacity-bound, a quota dimension from QUOTA_DIMENSIONS.

export const FEATURE_CATALOG: FeatureDef[] = [
  // CRM & Sales
  { key: "crm.pipeline", label: "Sales pipeline", module: "crm", kind: "boolean" },
  { key: "crm.bulk_import", label: "Bulk contact import", module: "crm", kind: "boolean", flag: "bulk_import" },

  // HR & People — headcount is capacity-bound to the employees quota.
  { key: "hr.core", label: "HR workspace", module: "hr", kind: "boolean" },
  { key: "hr.employees", label: "Employee records", module: "hr", kind: "limited", quota: "employees" },

  // Finance
  { key: "finance.core", label: "Finance & accounting", module: "finance", kind: "boolean" },
  { key: "finance.gst_filing", label: "GST filing", module: "finance", kind: "boolean", flag: "gst_filing" },

  // Inventory
  { key: "inventory.core", label: "Inventory & supply", module: "inventory", kind: "boolean" },

  // Projects & Jobs — background jobs are metered per month.
  { key: "projects.core", label: "Projects & jobs", module: "projects", kind: "boolean" },
  { key: "projects.jobs", label: "Background jobs", module: "projects", kind: "metered", quota: "jobs" },

  // Billing
  { key: "billing.subscriptions", label: "Subscription billing", module: "billing", kind: "boolean" },

  // Reporting — advanced reporting requires the "advanced" report tier.
  { key: "reports.standard", label: "Standard reports", module: "reports", kind: "boolean", requiresReport: "standard" },
  { key: "reports.advanced", label: "Advanced reports", module: "reports", kind: "boolean", requiresReport: "advanced" },

  // Automation — active automations are capacity-bound.
  { key: "automation.workflows", label: "Automation workflows", module: "automation", kind: "limited", quota: "automations" },

  // AI — assistant usage is metered against monthly AI credits.
  { key: "ai.assistant", label: "AI assistant", module: "ai", kind: "metered", quota: "ai_credits_per_month" },

  // Integrations — connected integrations are capacity-bound; API is metered.
  { key: "integrations.connectors", label: "Integration connectors", module: "integrations", kind: "limited", quota: "integrations" },
  { key: "integrations.api", label: "Public API access", module: "integrations", kind: "metered", quota: "api_calls_per_month" },
]

const FEATURE_INDEX: Map<string, FeatureDef> = new Map(FEATURE_CATALOG.map((f) => [f.key, f]))

export function getFeatureDef(key: string): FeatureDef | undefined {
  return FEATURE_INDEX.get(key.trim().toLowerCase())
}

export function featuresForModule(moduleKey: ModuleKey): FeatureDef[] {
  return FEATURE_CATALOG.filter((f) => f.module === moduleKey)
}

// ---------------------------------------------------------------------------
// Phase 2 — pure resolution of a feature into its state.
// ---------------------------------------------------------------------------

export type FeatureResolution = {
  key: string
  label: string
  module: ModuleKey
  kind: FeatureKind
  /** The resolved canonical state. */
  state: FeatureState
  /** Can the tenant use it AT ALL right now (metered overage still counts as usable)? */
  available: boolean
  /** Why it is disabled / capped, for surfacing to callers. */
  reason?: string
  // Capacity context (present for limited/metered features).
  quota?: QuotaKey
  limit?: Quota
  usage?: number
  remaining?: number | null
  /** True for a metered feature whose measured usage exceeds its cap. */
  overage?: boolean
}

/**
 * Resolve one feature against a plan's entitlements. `usage` is the tenant's
 * current consumption of the backing quota; `requested` is how many new units
 * this resolution is testing room for (default 0 = "just report state").
 *
 * The module gate comes first: a feature whose module is not in the plan is
 * DISABLED regardless of its kind — this is the primary server-side line of
 * defense that UI hiding alone can never provide.
 */
export function resolveFeature(
  ent: PlanEntitlements,
  def: FeatureDef,
  usage = 0,
  requested = 0,
): FeatureResolution {
  const base = { key: def.key, label: def.label, module: def.module, kind: def.kind }

  // 1. Module gate — the hard capability line.
  if (!hasModule(ent, def.module)) {
    return { ...base, state: "disabled", available: false, reason: `The "${def.module}" module is not in your plan` }
  }

  // 2. Boolean capability — flag / report tier gated.
  if (def.kind === "boolean") {
    if (def.flag && !hasFeatureFlag(ent, def.flag)) {
      return { ...base, state: "disabled", available: false, reason: `Feature flag "${def.flag}" is not enabled on your plan` }
    }
    if (def.requiresReport && !meetsReportLevel(ent, def.requiresReport)) {
      return { ...base, state: "disabled", available: false, reason: `Requires the "${def.requiresReport}" reporting tier` }
    }
    return { ...base, state: "enabled", available: true }
  }

  // 3/4. Capacity-bound (limited / metered) — both read a quota dimension.
  const quota = def.quota as QuotaKey
  const limit = ent[quota]
  const check = checkQuota(ent, quota, usage, requested)

  // A zero allowance disables the feature outright, whatever its kind.
  if (!isUnlimited(limit) && (limit as number) === 0) {
    return {
      ...base,
      state: "disabled",
      available: false,
      reason: `Your plan allows 0 for ${quota.replace(/_/g, " ")}`,
      quota,
      limit,
      usage: check.usage,
      remaining: 0,
    }
  }

  if (def.kind === "metered") {
    // Metered is always usable; past the cap it is billable overage, not a block.
    const overage = !isUnlimited(limit) && check.usage + Math.max(0, requested) > (limit as number)
    return {
      ...base,
      state: "metered",
      available: true,
      quota,
      limit,
      usage: check.usage,
      remaining: check.remaining,
      overage,
      reason: overage ? `Usage exceeds the included ${quota.replace(/_/g, " ")} allowance (billable overage)` : undefined,
    }
  }

  // limited: unlimited quota collapses to a plain ENABLED capability.
  if (isUnlimited(limit)) {
    return { ...base, state: "enabled", available: true, quota, limit: null, usage: check.usage, remaining: null }
  }
  return {
    ...base,
    state: "limited",
    available: check.allowed,
    quota,
    limit,
    usage: check.usage,
    remaining: check.remaining,
    reason: check.allowed ? undefined : `Plan limit reached for ${quota.replace(/_/g, " ")} (${check.usage}/${check.limit})`,
  }
}

/** Resolve a feature by key. Unknown keys are treated as DISABLED (fail closed). */
export function resolveFeatureByKey(
  ent: PlanEntitlements,
  key: string,
  usage = 0,
  requested = 0,
): FeatureResolution {
  const def = getFeatureDef(key)
  if (!def) {
    return {
      key: key.trim().toLowerCase(),
      label: key,
      module: "crm",
      kind: "boolean",
      state: "disabled",
      available: false,
      reason: `Unknown feature "${key}"`,
    }
  }
  return resolveFeature(ent, def, usage, requested)
}

/**
 * Resolve the WHOLE catalog against a plan. `usageByQuota` supplies live usage
 * per quota dimension (defaults to 0 for anything not provided). Used to render
 * a plan's feature matrix in the Super Admin UI and a tenant's own feature map.
 */
export function resolveAllFeatures(
  ent: PlanEntitlements,
  usageByQuota: Partial<Record<QuotaKey, number>> = {},
): FeatureResolution[] {
  return FEATURE_CATALOG.map((def) =>
    resolveFeature(ent, def, def.quota ? (usageByQuota[def.quota] ?? 0) : 0, 0),
  )
}
