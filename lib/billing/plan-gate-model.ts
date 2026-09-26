/**
 * Spec46 (#165, #170-171) — request-level PLAN entitlement gate. Edge-safe and
 * pure: no DB, no framework. Maps an API path onto a FEATURE_CATALOG key and
 * resolves it against the tenant's plan with the same `resolveFeature` the UI
 * and route guards use, so "what the plan shows" and "what the API allows"
 * cannot drift.
 *
 * Only a tenant with a platform subscription is gated (`plan === null` means
 * legacy/unsubscribed → never stripped of modules, matching isModuleInPlan).
 */
import type { ModuleKey, PlanEntitlements } from "@/lib/platform/entitlements"
import { hasModule } from "@/lib/platform/entitlements"
import { resolveFeatureByKey } from "@/lib/platform/feature-entitlements"

export const PLAN_REQUIRED_CODE = "PLAN_REQUIRED"
export const PLAN_REQUIRED_STATUS = 403

/** Workspace/API module slug → plan module. Single source for pages and APIs. */
export const MODULE_PLAN_KEY: Readonly<Record<string, ModuleKey>> = {
  hr: "hr",
  recruitment: "hr",
  recruit: "hr",
  finance: "finance",
  sales: "crm",
  tickets: "crm",
  products: "inventory",
  operations: "projects",
}

/** Module slug → the feature that represents "may use this module at all". */
const MODULE_CORE_FEATURE: Readonly<Record<ModuleKey, string | undefined>> = {
  hr: "hr.core",
  finance: "finance.core",
  crm: "crm.pipeline",
  inventory: "inventory.core",
  projects: "projects.core",
  billing: undefined,
  reports: undefined,
  automation: undefined,
  ai: undefined,
  integrations: undefined,
}

/**
 * Action-level rules: an API path prefix that additionally requires a
 * flag-gated feature. Most specific prefix wins; checked before the module rule.
 */
// Empty by design: flag-gated features (e.g. finance.gst_filing) are not yet
// granted by any preset or stored plan, so gating them would strip existing
// tenants. Add a rule here once the flag is provisioned on the relevant plans.
export const PLAN_ACTION_RULES: ReadonlyArray<{ prefix: string; feature: string }> = []

export function planModuleKey(slug: string): ModuleKey | null {
  const base = String(slug ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .split(/[/?#]/)[0]
  return MODULE_PLAN_KEY[base] ?? null
}

export function planAllowsModule(entitlements: PlanEntitlements | null, slug: string): boolean {
  const key = planModuleKey(slug)
  if (!key || !entitlements) return true
  return hasModule(entitlements, key)
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** The feature key a request needs, or null when the path is not plan-gated. */
export function requiredFeatureForPath(pathname: string): string | null {
  if (!pathname.startsWith("/api/")) return null
  const rule = PLAN_ACTION_RULES.find((r) => matchesPrefix(pathname, r.prefix))
  if (rule) return rule.feature
  const moduleKey = planModuleKey(pathname.slice("/api/".length))
  return moduleKey ? (MODULE_CORE_FEATURE[moduleKey] ?? null) : null
}

export type PlanGateDenial = { code: typeof PLAN_REQUIRED_CODE; feature: string; reason: string }

/** Pure decision: null = allowed, otherwise the denial to return. */
export function evaluatePlanGate(
  pathname: string,
  plan: PlanEntitlements | null | undefined,
  platformRole?: string | null,
): PlanGateDenial | null {
  if (!plan) return null
  if (platformRole && platformRole !== "none") return null
  const feature = requiredFeatureForPath(pathname)
  if (!feature) return null
  const resolution = resolveFeatureByKey(plan, feature)
  if (resolution.available) return null
  return {
    code: PLAN_REQUIRED_CODE,
    feature,
    reason: `${resolution.reason ?? "Not included in your plan"}. Upgrade your plan to continue.`,
  }
}
