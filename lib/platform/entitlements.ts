/**
 * SPEC 17 — Phase 1. The plan ENTITLEMENT model.
 * ---------------------------------------------------------------------------
 * A plan is more than a price: it is the contract for what a tenant is allowed
 * to do. This module is the single, pure (DB-free, framework-free) definition
 * of that contract so it can be validated once and enforced everywhere.
 *
 * Two shapes of entitlement live here:
 *   • QUOTAS  — numeric ceilings (users, employees, storage, API calls,
 *               automations, jobs, AI usage, integrations). `null` means
 *               UNLIMITED. A finite value is the hard cap.
 *   • GRANTS  — capabilities the plan unlocks: enabled ERP modules, a report
 *               tier, a support tier, and named feature flags.
 *
 * Everything is normalized through `normalizeEntitlements`, so storage,
 * transport (JSON), and enforcement all agree on one canonical representation.
 */

// ---------------------------------------------------------------------------
// Catalog constants — the closed vocabularies a plan draws from.
// ---------------------------------------------------------------------------

/** ERP modules a plan can switch on. Keys match the workspace module registry. */
export const MODULE_CATALOG = [
  { key: "crm", label: "CRM & Sales" },
  { key: "hr", label: "HR & People" },
  { key: "finance", label: "Finance & Accounting" },
  { key: "inventory", label: "Inventory & Supply" },
  { key: "projects", label: "Projects & Jobs" },
  { key: "billing", label: "Billing & Subscriptions" },
  { key: "reports", label: "Reporting & Analytics" },
  { key: "automation", label: "Automation & Workflows" },
  { key: "ai", label: "AI Assistant" },
  { key: "integrations", label: "Integrations" },
] as const

export type ModuleKey = (typeof MODULE_CATALOG)[number]["key"]
export const MODULE_KEYS: ModuleKey[] = MODULE_CATALOG.map((m) => m.key)

/** Reporting tiers, ordered weakest → strongest. */
export const REPORT_LEVELS = ["none", "standard", "advanced"] as const
export type ReportLevel = (typeof REPORT_LEVELS)[number]

/** Support tiers, ordered weakest → strongest. */
export const SUPPORT_LEVELS = ["community", "email", "priority", "dedicated"] as const
export type SupportLevel = (typeof SUPPORT_LEVELS)[number]

/**
 * The numeric quota dimensions. Kept as a list so enforcement, UI and tests
 * can iterate the same source of truth rather than hard-coding field names.
 */
export const QUOTA_DIMENSIONS = [
  { key: "users", label: "Users", unit: "seats" },
  { key: "employees", label: "Employees", unit: "records" },
  { key: "storage_gb", label: "Storage", unit: "GB" },
  { key: "api_calls_per_month", label: "API calls", unit: "/mo" },
  { key: "automations", label: "Automations", unit: "active" },
  { key: "jobs", label: "Background jobs", unit: "/mo" },
  { key: "ai_credits_per_month", label: "AI usage", unit: "credits/mo" },
  { key: "integrations", label: "Integrations", unit: "connected" },
] as const

export type QuotaKey = (typeof QUOTA_DIMENSIONS)[number]["key"]
export const QUOTA_KEYS: QuotaKey[] = QUOTA_DIMENSIONS.map((q) => q.key)

// ---------------------------------------------------------------------------
// The entitlement shape.
// ---------------------------------------------------------------------------

/** A numeric quota. `null` === unlimited. Finite values are always >= 0 ints. */
export type Quota = number | null

export type PlanEntitlements = {
  /** Enabled ERP modules (subset of MODULE_KEYS). */
  modules: ModuleKey[]
  /** Numeric ceilings; null = unlimited. */
  users: Quota
  employees: Quota
  storage_gb: Quota
  api_calls_per_month: Quota
  automations: Quota
  jobs: Quota
  ai_credits_per_month: Quota
  integrations: Quota
  /** Highest report tier the plan unlocks. */
  reports: ReportLevel
  /** Support tier bundled with the plan. */
  support_level: SupportLevel
  /** Named feature flags this plan grants (plan-level entitlement flags). */
  feature_flags: string[]
}

// ---------------------------------------------------------------------------
// Normalization — coerce arbitrary/JSON input into a canonical entitlement.
// ---------------------------------------------------------------------------

/** The safe floor: an empty plan grants nothing and caps everything at zero. */
export const EMPTY_ENTITLEMENTS: PlanEntitlements = {
  modules: [],
  users: 0,
  employees: 0,
  storage_gb: 0,
  api_calls_per_month: 0,
  automations: 0,
  jobs: 0,
  ai_credits_per_month: 0,
  integrations: 0,
  reports: "none",
  support_level: "community",
  feature_flags: [],
}

function normalizeQuota(value: unknown): Quota {
  // Unlimited is expressed as null, and also accepted as "", "unlimited", -1,
  // or Infinity for ergonomic form/JSON input.
  if (value == null || value === "") return null
  if (typeof value === "string") {
    const t = value.trim().toLowerCase()
    if (t === "" || t === "unlimited" || t === "∞") return null
    const n = Number(t)
    if (!Number.isFinite(n)) return null
    if (n < 0) return null
    return Math.floor(n)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null
    if (value < 0) return null
    return Math.floor(value)
  }
  return 0
}

function normalizeStringList(value: unknown, allowed?: readonly string[]): string[] {
  let raw: string[]
  if (Array.isArray(value)) raw = value.map((v) => String(v))
  else if (typeof value === "string") raw = value.split(",")
  else raw = []
  const cleaned = raw.map((s) => s.trim().toLowerCase()).filter(Boolean)
  const filtered = allowed ? cleaned.filter((s) => (allowed as readonly string[]).includes(s)) : cleaned
  return Array.from(new Set(filtered))
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const t = typeof value === "string" ? value.trim().toLowerCase() : ""
  return (allowed as readonly string[]).includes(t) ? (t as T) : fallback
}

/**
 * Turn arbitrary input (a form body, a stored JSON blob, a partial object) into
 * a complete, valid `PlanEntitlements`. Unknown/invalid fields fall back to the
 * safe floor rather than throwing, so a corrupt stored value can never crash a
 * request — it simply grants the minimum.
 */
export function normalizeEntitlements(input: unknown): PlanEntitlements {
  const src: Record<string, unknown> =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  return {
    modules: normalizeStringList(src.modules, MODULE_KEYS) as ModuleKey[],
    users: normalizeQuota(src.users),
    employees: normalizeQuota(src.employees),
    storage_gb: normalizeQuota(src.storage_gb),
    api_calls_per_month: normalizeQuota(src.api_calls_per_month),
    automations: normalizeQuota(src.automations),
    jobs: normalizeQuota(src.jobs),
    ai_credits_per_month: normalizeQuota(src.ai_credits_per_month),
    integrations: normalizeQuota(src.integrations),
    reports: normalizeEnum(src.reports, REPORT_LEVELS, "none"),
    support_level: normalizeEnum(src.support_level, SUPPORT_LEVELS, "community"),
    feature_flags: normalizeStringList(src.feature_flags),
  }
}

/** Safe JSON parse for a stored entitlements column. */
export function parseEntitlements(raw: unknown): PlanEntitlements {
  if (raw == null) return { ...EMPTY_ENTITLEMENTS }
  if (typeof raw === "string") {
    try {
      return normalizeEntitlements(JSON.parse(raw))
    } catch {
      return { ...EMPTY_ENTITLEMENTS }
    }
  }
  return normalizeEntitlements(raw)
}

// ---------------------------------------------------------------------------
// Enforcement primitives — pure predicates used by the server-side guard.
// ---------------------------------------------------------------------------

export function isUnlimited(q: Quota): boolean {
  return q == null
}

export function hasModule(ent: PlanEntitlements, moduleKey: string): boolean {
  return ent.modules.includes(moduleKey as ModuleKey)
}

export function hasFeatureFlag(ent: PlanEntitlements, flagKey: string): boolean {
  return ent.feature_flags.includes(flagKey.trim().toLowerCase())
}

export function reportLevelRank(level: ReportLevel): number {
  return REPORT_LEVELS.indexOf(level)
}

export function supportLevelRank(level: SupportLevel): number {
  return SUPPORT_LEVELS.indexOf(level)
}

/** Does the plan meet or exceed a required report tier? */
export function meetsReportLevel(ent: PlanEntitlements, required: ReportLevel): boolean {
  return reportLevelRank(ent.reports) >= reportLevelRank(required)
}

export type LimitCheck = {
  dimension: QuotaKey
  /** null = unlimited. */
  limit: Quota
  usage: number
  /** null = unlimited remaining. */
  remaining: number | null
  /** True when adding `requested` stays within the cap. */
  allowed: boolean
  unlimited: boolean
}

/**
 * The core quota check. Given the entitlement, a dimension, the tenant's
 * current usage and how many units they want to add, decide whether it fits.
 * Unlimited quotas always allow; finite quotas allow only while
 * `usage + requested <= limit`.
 */
export function checkQuota(
  ent: PlanEntitlements,
  dimension: QuotaKey,
  currentUsage: number,
  requested = 1,
): LimitCheck {
  const limit = ent[dimension]
  const usage = Math.max(0, Math.floor(Number.isFinite(currentUsage) ? currentUsage : 0))
  const add = Math.max(0, Math.floor(Number.isFinite(requested) ? requested : 0))
  if (isUnlimited(limit)) {
    return { dimension, limit: null, usage, remaining: null, allowed: true, unlimited: true }
  }
  const cap = limit as number
  const remaining = Math.max(0, cap - usage)
  return {
    dimension,
    limit: cap,
    usage,
    remaining,
    allowed: usage + add <= cap,
    unlimited: false,
  }
}

/** Human-readable quota, e.g. `Unlimited` or `250`. */
export function formatQuota(q: Quota): string {
  return isUnlimited(q) ? "Unlimited" : String(q)
}

// ---------------------------------------------------------------------------
// Presets — sensible defaults for the seeded plan catalog (SPEC 4/17).
// ---------------------------------------------------------------------------

export const ENTITLEMENT_PRESETS: Record<string, PlanEntitlements> = {
  // Mobile-first Shopkeeper plans use explicit flags. This keeps WhatsApp and
  // commerce access configurable per plan instead of accidentally inheriting
  // HR/recruitment ERP modules.
  shopkeeper: {
    modules: ["crm", "automation", "integrations", "reports"],
    users: 5,
    employees: 0,
    storage_gb: 5,
    api_calls_per_month: 25_000,
    automations: 10,
    jobs: 1_000,
    ai_credits_per_month: 0,
    integrations: 1,
    reports: "standard",
    support_level: "email",
    feature_flags: ["shopkeeper.mobile_app", "shopkeeper.whatsapp", "shopkeeper.inbox", "shopkeeper.contacts", "shopkeeper.templates", "shopkeeper.campaigns", "shopkeeper.automations", "shopkeeper.products", "shopkeeper.orders", "shopkeeper.team", "shopkeeper.subscription", "shopkeeper.settings"],
  },
  trial: {
    modules: ["crm", "hr", "finance", "reports"],
    users: 3,
    employees: 10,
    storage_gb: 1,
    api_calls_per_month: 1_000,
    automations: 1,
    jobs: 50,
    ai_credits_per_month: 100,
    integrations: 1,
    reports: "standard",
    support_level: "community",
    feature_flags: [],
  },
  starter: {
    modules: ["crm", "hr", "finance", "inventory", "reports"],
    users: 10,
    employees: 50,
    storage_gb: 10,
    api_calls_per_month: 25_000,
    automations: 10,
    jobs: 1_000,
    ai_credits_per_month: 2_000,
    integrations: 3,
    reports: "standard",
    support_level: "email",
    feature_flags: [],
  },
  growth: {
    modules: ["crm", "hr", "finance", "inventory", "projects", "billing", "reports", "automation"],
    users: 50,
    employees: 500,
    storage_gb: 100,
    api_calls_per_month: 250_000,
    automations: 100,
    jobs: 25_000,
    ai_credits_per_month: 25_000,
    integrations: 15,
    reports: "advanced",
    support_level: "priority",
    feature_flags: [],
  },
  enterprise: {
    modules: [...MODULE_KEYS],
    users: null,
    employees: null,
    storage_gb: null,
    api_calls_per_month: null,
    automations: null,
    jobs: null,
    ai_credits_per_month: null,
    integrations: null,
    reports: "advanced",
    support_level: "dedicated",
    feature_flags: [],
  },
}

/** Pick a preset by plan code, falling back to a modest default. */
export function presetForCode(code: string): PlanEntitlements {
  const key = code.trim().toLowerCase()
  return ENTITLEMENT_PRESETS[key] ?? ENTITLEMENT_PRESETS.starter
}
