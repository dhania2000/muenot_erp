import "server-only"
/**
 * Super Admin console data layer.
 * ---------------------------------------------------------------------------
 * Platform-level operational records the Muenot Super Admin console manages:
 * subscription PLANS, per-tenant SUBSCRIPTIONS, derived billing INVOICES,
 * FEATURE FLAGS (+ per-tenant overrides) and platform CONFIG.
 *
 * These are platform tables (not tenant-scoped): they describe the business of
 * running the platform itself, so access is gated on the PLATFORM axis only
 * (see lib/platform-guard.ts) — never a tenant role. Schema self-heals at
 * runtime like the rest of the codebase (lib/tenant-service.ts pattern), so an
 * existing install converges without a manual migration step.
 *
 * Everything here derives from REAL data: plans are platform defaults, a
 * subscription is provisioned per real tenant (seeded from tenants.plan), and
 * invoices are computed from those subscriptions. Nothing is fabricated
 * history — an operator's actions extend the records from there.
 */
import { query } from "@/lib/db"
import { listTenants, type Tenant } from "@/lib/tenant-service"
import {
  type PlanEntitlements,
  EMPTY_ENTITLEMENTS,
  normalizeEntitlements,
  parseEntitlements,
  presetForCode,
} from "@/lib/platform/entitlements"
import { invalidateTenantTarget, invalidateTargetForAllTenants } from "@/lib/tenant-cache"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanCode = string
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled"

export type Plan = {
  code: PlanCode
  name: string
  description: string | null
  price_monthly: number
  currency: string
  seat_limit: number | null
  features: string[]
  /** the structured entitlement contract for this plan. */
  entitlements: PlanEntitlements
  is_active: boolean
  sort_order: number
}

export type TenantSubscription = {
  id: number
  tenant_id: number
  plan_code: PlanCode
  status: SubscriptionStatus
  seats: number
  mrr: number
  currency: string
  current_period_start: string | null
  current_period_end: string | null
  trial_end: string | null
  canceled_at: string | null
  updated_at: string
}

export type FeatureFlag = {
  key: string
  name: string
  description: string | null
  enabled: boolean
  rollout_percentage: number
  updated_at: string
  override_count?: number
}

export type PlatformConfigEntry = {
  config_key: string
  config_value: string | null
  category: string
  description: string | null
  is_secret: boolean
  updated_at: string
}

// ---------------------------------------------------------------------------
// Defaults (platform-defined, seeded once)
// ---------------------------------------------------------------------------

const DEFAULT_PLANS: Omit<Plan, "is_active">[] = [
  {
    code: "internal",
    name: "Internal",
    description: "Muenot-owned platform tenant. Not billed.",
    price_monthly: 0,
    currency: "USD",
    seat_limit: null,
    features: ["all_modules", "priority_support", "unlimited_storage"],
    entitlements: presetForCode("enterprise"),
    sort_order: 0,
  },
  {
    // mobile-first Shopkeeper trial. Zero price; provisioned with a
    // `trialing` subscription. Uses the shopkeeper entitlement preset so the
    // Android app's shopkeeper.* feature gates resolve correctly.
    code: "shopkeeper-trial",
    name: "Shopkeeper Trial",
    description: "14-day trial of the Muenot Shopkeeper mobile app.",
    price_monthly: 0,
    currency: "USD",
    seat_limit: 5,
    features: ["shopkeeper_app", "whatsapp", "trial"],
    entitlements: presetForCode("shopkeeper"),
    sort_order: 1,
  },
  {
    // the standard paid Shopkeeper plan.
    code: "shopkeeper",
    name: "Shopkeeper",
    description: "The Muenot Shopkeeper mobile app for a single shop.",
    price_monthly: 15,
    currency: "USD",
    seat_limit: 5,
    features: ["shopkeeper_app", "whatsapp", "email_support"],
    entitlements: presetForCode("shopkeeper"),
    sort_order: 2,
  },
  {
    code: "starter",
    name: "Starter",
    description: "For small teams getting started.",
    price_monthly: 49,
    currency: "USD",
    seat_limit: 10,
    features: ["core_modules", "email_support"],
    entitlements: presetForCode("starter"),
    sort_order: 3,
  },
  {
    code: "growth",
    name: "Growth",
    description: "For scaling businesses that need more.",
    price_monthly: 199,
    currency: "USD",
    seat_limit: 50,
    features: ["all_modules", "email_support", "api_access"],
    entitlements: presetForCode("growth"),
    sort_order: 2,
  },
  {
    code: "enterprise",
    name: "Enterprise",
    description: "Dedicated support and unlimited scale.",
    price_monthly: 999,
    currency: "USD",
    seat_limit: null,
    features: ["all_modules", "priority_support", "api_access", "sso", "dedicated_db"],
    entitlements: presetForCode("enterprise"),
    sort_order: 3,
  },
]

const DEFAULT_FLAGS: Omit<FeatureFlag, "updated_at" | "override_count">[] = [
  { key: "new_billing_ui", name: "New billing UI", description: "Roll out the redesigned billing screens.", enabled: false, rollout_percentage: 0 },
  { key: "ai_assistant", name: "AI assistant", description: "In-app AI assistant across modules.", enabled: false, rollout_percentage: 10 },
  { key: "advanced_reports", name: "Advanced reports", description: "Extended finance & analytics reporting.", enabled: true, rollout_percentage: 100 },
  { key: "self_serve_signup", name: "Self-serve signup", description: "Allow tenants to sign up without an operator.", enabled: false, rollout_percentage: 0 },
]

const DEFAULT_CONFIG: Omit<PlatformConfigEntry, "updated_at">[] = [
  { config_key: "platform.name", config_value: "Muenot", category: "general", description: "Display name of the platform.", is_secret: false },
  { config_key: "platform.support_email", config_value: "support@muenot.com", category: "general", description: "Support contact shown to tenants.", is_secret: false },
  { config_key: "billing.currency", config_value: "USD", category: "billing", description: "Default billing currency.", is_secret: false },
  { config_key: "billing.trial_days", config_value: "14", category: "billing", description: "Default trial length for new tenants.", is_secret: false },
  { config_key: "security.session_ttl_hours", config_value: "12", category: "security", description: "Session lifetime before re-auth.", is_secret: false },
  { config_key: "security.max_login_attempts", config_value: "5", category: "security", description: "Failed logins before lockout.", is_secret: false },
  { config_key: "tenants.default_plan", config_value: "starter", category: "tenants", description: "Plan assigned to new tenants.", is_secret: false },
]

/** Map a tenant's coarse plan string onto a console plan code. */
function planCodeForTenant(t: Tenant): PlanCode {
  if (t.is_platform_owner) return "internal"
  const p = (t.plan || "").toLowerCase()
  if (p === "internal") return "internal"
  if (p === "enterprise") return "enterprise"
  if (p === "growth" || p === "standard") return "growth"
  // Shopkeeper tenants carry their console plan code directly in tenants.plan
  // (e.g. "shopkeeper" / "shopkeeper-trial"). Preserve it so re-derivation
  // keeps the mobile shopkeeper.* entitlements instead of falling back.
  if (p === "shopkeeper" || p === "shopkeeper-trial") return p as PlanCode
  return "starter"
}

// ---------------------------------------------------------------------------
// Schema (self-healing)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

/** Add a column only if it doesn't already exist (MySQL has no portable ADD COLUMN IF NOT EXISTS). */
async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  const rows = await query<any[]>(
    `SELECT COUNT(*) AS c FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  if (Number(rows?.[0]?.c ?? 0) > 0) return
  await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
}

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_plans\` (
      \`code\` VARCHAR(40) NOT NULL,
      \`name\` VARCHAR(100) NOT NULL,
      \`description\` VARCHAR(255) DEFAULT NULL,
      \`price_monthly\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`currency\` VARCHAR(10) NOT NULL DEFAULT 'USD',
      \`seat_limit\` INT UNSIGNED DEFAULT NULL,
      \`features\` JSON DEFAULT NULL,
      \`entitlements\` JSON DEFAULT NULL,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`sort_order\` INT NOT NULL DEFAULT 0,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`code\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // add the entitlements column to installs created before it existed.
  await ensureColumn("platform_plans", "entitlements", "JSON DEFAULT NULL")

  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_subscriptions\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`plan_code\` VARCHAR(40) NOT NULL,
      \`status\` ENUM('trialing','active','past_due','canceled') NOT NULL DEFAULT 'active',
      \`seats\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`mrr\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`currency\` VARCHAR(10) NOT NULL DEFAULT 'USD',
      \`current_period_start\` DATE DEFAULT NULL,
      \`current_period_end\` DATE DEFAULT NULL,
      \`trial_end\` DATE DEFAULT NULL,
      \`canceled_at\` DATE DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_sub_tenant\` (\`tenant_id\`),
      KEY \`idx_sub_status\` (\`status\`),
      KEY \`idx_sub_plan\` (\`plan_code\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_invoices\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`invoice_number\` VARCHAR(40) NOT NULL,
      \`amount\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`currency\` VARCHAR(10) NOT NULL DEFAULT 'USD',
      \`status\` ENUM('open','paid','void') NOT NULL DEFAULT 'open',
      \`period_start\` DATE DEFAULT NULL,
      \`period_end\` DATE DEFAULT NULL,
      \`issued_at\` DATE DEFAULT NULL,
      \`paid_at\` DATE DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_invoice_number\` (\`invoice_number\`),
      KEY \`idx_inv_tenant\` (\`tenant_id\`),
      KEY \`idx_inv_status\` (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_feature_flags\` (
      \`flag_key\` VARCHAR(60) NOT NULL,
      \`name\` VARCHAR(120) NOT NULL,
      \`description\` VARCHAR(255) DEFAULT NULL,
      \`enabled\` TINYINT(1) NOT NULL DEFAULT 0,
      \`rollout_percentage\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`flag_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_feature_flag_overrides\` (
      \`flag_key\` VARCHAR(60) NOT NULL,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`enabled\` TINYINT(1) NOT NULL DEFAULT 0,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`flag_key\`, \`tenant_id\`),
      KEY \`idx_ffo_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS \`platform_config\` (
      \`config_key\` VARCHAR(100) NOT NULL,
      \`config_value\` TEXT DEFAULT NULL,
      \`category\` VARCHAR(40) NOT NULL DEFAULT 'general',
      \`description\` VARCHAR(255) DEFAULT NULL,
      \`is_secret\` TINYINT(1) NOT NULL DEFAULT 0,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`config_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Seed platform defaults (idempotent — never clobber operator edits).
  for (const p of DEFAULT_PLANS) {
    await query(
      `INSERT INTO \`platform_plans\` (\`code\`, \`name\`, \`description\`, \`price_monthly\`, \`currency\`, \`seat_limit\`, \`features\`, \`entitlements\`, \`is_active\`, \`sort_order\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE \`code\` = \`code\``,
      [
        p.code,
        p.name,
        p.description,
        p.price_monthly,
        p.currency,
        p.seat_limit,
        JSON.stringify(p.features),
        JSON.stringify(p.entitlements),
        p.sort_order,
      ],
    )
  }
  for (const f of DEFAULT_FLAGS) {
    await query(
      `INSERT INTO \`platform_feature_flags\` (\`flag_key\`, \`name\`, \`description\`, \`enabled\`, \`rollout_percentage\`)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`flag_key\` = \`flag_key\``,
      [f.key, f.name, f.description, f.enabled ? 1 : 0, f.rollout_percentage],
    )
  }
  for (const c of DEFAULT_CONFIG) {
    await query(
      `INSERT INTO \`platform_config\` (\`config_key\`, \`config_value\`, \`category\`, \`description\`, \`is_secret\`)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`config_key\` = \`config_key\``,
      [c.config_key, c.config_value, c.category, c.description, c.is_secret ? 1 : 0],
    )
  }

  await provisionSubscriptions()
}

/** Ensure schema + defaults exist. Cached per process; safe to call often. */
export async function ensurePlatformConsoleSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Subscription provisioning (derives from real tenants)
// ---------------------------------------------------------------------------

function addMonths(date: Date, months: number): Date {
  const d = new Date(date)
  d.setMonth(d.getMonth() + months)
  return d
}
const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Ensure every tenant has exactly one subscription row, seeded from its plan.
 * Existing rows are left untouched so operator edits persist. Called from
 * ensure(), so the console always reflects the real tenant roster.
 */
async function provisionSubscriptions(): Promise<void> {
  const tenants = await listTenants()
  const plans = await listPlansRaw()
  const planByCode = new Map(plans.map((p) => [p.code, p]))
  const now = new Date()

  for (const t of tenants) {
    const code = planCodeForTenant(t)
    const plan = planByCode.get(code) ?? planByCode.get("starter")
    const price = plan?.price_monthly ?? 0
    const status: SubscriptionStatus = t.status === "active" ? "active" : t.status === "suspended" ? "past_due" : "canceled"
    await query(
      `INSERT INTO \`tenant_subscriptions\`
         (\`tenant_id\`, \`plan_code\`, \`status\`, \`seats\`, \`mrr\`, \`currency\`, \`current_period_start\`, \`current_period_end\`)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`tenant_id\` = \`tenant_id\``,
      [t.id, code, status, price, plan?.currency ?? "USD", iso(now), iso(addMonths(now, 1))],
    )
  }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

type PlanRow = Omit<Plan, "features" | "entitlements" | "is_active"> & {
  features: string | null
  entitlements: string | null
  is_active: number
}

function mapPlan(r: PlanRow): Plan {
  let features: string[] = []
  if (r.features) {
    try {
      const parsed = typeof r.features === "string" ? JSON.parse(r.features) : r.features
      if (Array.isArray(parsed)) features = parsed.map(String)
    } catch {
      features = []
    }
  }
  // A pre- row has a NULL entitlements column: fall back to the tier
  // preset so the plan still has a meaningful contract, never a bare floor.
  const entitlements =
    r.entitlements != null ? parseEntitlements(r.entitlements) : presetForCode(r.code)
  return {
    code: r.code,
    name: r.name,
    description: r.description,
    price_monthly: Number(r.price_monthly),
    currency: r.currency,
    seat_limit: r.seat_limit != null ? Number(r.seat_limit) : null,
    features,
    entitlements,
    is_active: Boolean(r.is_active),
    sort_order: Number(r.sort_order),
  }
}

async function listPlansRaw(): Promise<Plan[]> {
  const rows = await query<PlanRow[]>("SELECT * FROM `platform_plans` ORDER BY `sort_order` ASC, `price_monthly` ASC")
  return rows.map(mapPlan)
}

export async function listPlans(): Promise<Plan[]> {
  await ensurePlatformConsoleSchema()
  return listPlansRaw()
}

export async function upsertPlan(input: {
  code: string
  name: string
  description?: string | null
  price_monthly: number
  currency?: string
  seat_limit?: number | null
  features?: string[]
  entitlements?: unknown
  sort_order?: number
}): Promise<void> {
  await ensurePlatformConsoleSchema()
  const code = input.code.toLowerCase().trim()
  if (!/^[a-z0-9_-]{2,40}$/.test(code)) throw new Error("Plan code must be 2-40 chars: letters, digits, - or _")
  if (!input.name?.trim()) throw new Error("Plan name is required")
  if (!Number.isFinite(input.price_monthly) || input.price_monthly < 0) throw new Error("Price must be a non-negative number")
  // Entitlements are normalized to the canonical shape before persistence so a
  // malformed form body can never write an invalid contract. When omitted on an
  // update we keep the existing value; on insert we seed the tier preset.
  const existing = (await query<PlanRow[]>("SELECT * FROM `platform_plans` WHERE `code` = ?", [code]))[0]
  const entitlements: PlanEntitlements =
    input.entitlements !== undefined
      ? normalizeEntitlements(input.entitlements)
      : existing
        ? parseEntitlements(existing.entitlements)
        : presetForCode(code)
  await query(
    `INSERT INTO \`platform_plans\` (\`code\`, \`name\`, \`description\`, \`price_monthly\`, \`currency\`, \`seat_limit\`, \`features\`, \`entitlements\`, \`sort_order\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       \`name\` = VALUES(\`name\`), \`description\` = VALUES(\`description\`),
       \`price_monthly\` = VALUES(\`price_monthly\`), \`currency\` = VALUES(\`currency\`),
       \`seat_limit\` = VALUES(\`seat_limit\`), \`features\` = VALUES(\`features\`),
       \`entitlements\` = VALUES(\`entitlements\`), \`sort_order\` = VALUES(\`sort_order\`)`,
    [
      code,
      input.name.trim(),
      input.description ?? null,
      input.price_monthly,
      input.currency ?? "USD",
      input.seat_limit ?? null,
      JSON.stringify(input.features ?? []),
      JSON.stringify(entitlements),
      input.sort_order ?? 0,
    ],
  )
  // a plan's entitlements just changed for EVERY tenant on that plan.
  // There is no per-tenant key to target, so clear the entitlements cache.
  invalidateTargetForAllTenants("entitlements")
}

export async function setPlanActive(code: string, active: boolean): Promise<void> {
  await ensurePlatformConsoleSchema()
  await query("UPDATE `platform_plans` SET `is_active` = ? WHERE `code` = ?", [active ? 1 : 0, code])
  // activation state gates plan resolution across tenants.
  invalidateTargetForAllTenants("entitlements")
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

type SubRow = Omit<TenantSubscription, "mrr" | "seats"> & { mrr: string | number; seats: string | number }

export type SubscriptionWithTenant = TenantSubscription & {
  tenant_name: string
  tenant_slug: string
  tenant_status: Tenant["status"]
  plan_name: string
}

export async function listSubscriptions(): Promise<SubscriptionWithTenant[]> {
  await ensurePlatformConsoleSchema()
  const rows = await query<any[]>(
    `SELECT s.*, t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status,
            COALESCE(p.name, s.plan_code) AS plan_name
       FROM \`tenant_subscriptions\` s
       JOIN \`tenants\` t ON t.id = s.tenant_id
       LEFT JOIN \`platform_plans\` p ON p.code = s.plan_code
      ORDER BY t.is_platform_owner DESC, t.name ASC`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    plan_code: r.plan_code,
    status: r.status,
    seats: Number(r.seats),
    mrr: Number(r.mrr),
    currency: r.currency,
    current_period_start: r.current_period_start,
    current_period_end: r.current_period_end,
    trial_end: r.trial_end,
    canceled_at: r.canceled_at,
    updated_at: r.updated_at,
    tenant_name: r.tenant_name,
    tenant_slug: r.tenant_slug,
    tenant_status: r.tenant_status,
    plan_name: r.plan_name,
  }))
}

export async function getSubscriptionForTenant(tenantId: number): Promise<TenantSubscription | null> {
  await ensurePlatformConsoleSchema()
  const rows = await query<SubRow[]>("SELECT * FROM `tenant_subscriptions` WHERE `tenant_id` = ? LIMIT 1", [tenantId])
  const r = rows[0]
  if (!r) return null
  return { ...r, mrr: Number(r.mrr), seats: Number(r.seats) }
}

export async function changeSubscriptionPlan(tenantId: number, planCode: string): Promise<void> {
  await ensurePlatformConsoleSchema()
  const plans = await listPlansRaw()
  const plan = plans.find((p) => p.code === planCode)
  if (!plan) throw new Error(`Unknown plan "${planCode}"`)
  if (!plan.is_active) throw new Error(`Plan "${planCode}" is not active`)
  await query("UPDATE `tenant_subscriptions` SET `plan_code` = ?, `mrr` = ?, `currency` = ? WHERE `tenant_id` = ?", [
    plan.code,
    plan.price_monthly,
    plan.currency,
    tenantId,
  ])
  // this tenant's plan changed; drop its cached entitlements.
  invalidateTenantTarget("entitlements", tenantId)
}

export async function setSubscriptionStatus(tenantId: number, status: SubscriptionStatus): Promise<void> {
  await ensurePlatformConsoleSchema()
  const canceledAt = status === "canceled" ? iso(new Date()) : null
  await query("UPDATE `tenant_subscriptions` SET `status` = ?, `canceled_at` = ? WHERE `tenant_id` = ?", [
    status,
    canceledAt,
    tenantId,
  ])
  // subscription status feeds entitlement resolution for this tenant.
  invalidateTenantTarget("entitlements", tenantId)
}

// ---------------------------------------------------------------------------
// Invoices (derived from active subscriptions; operator marks them paid)
// ---------------------------------------------------------------------------

export type InvoiceWithTenant = {
  id: number
  tenant_id: number
  tenant_name: string
  invoice_number: string
  amount: number
  currency: string
  status: "open" | "paid" | "void"
  period_start: string | null
  period_end: string | null
  issued_at: string | null
  paid_at: string | null
}

/**
 * Generate the current-period invoice for every billable (non-zero MRR)
 * subscription that does not already have one for that period. Pure derivation
 * from real subscriptions — never fabricates historical charges.
 */
export async function ensureCurrentInvoices(): Promise<void> {
  await ensurePlatformConsoleSchema()
  const subs = await listSubscriptions()
  for (const s of subs) {
    if (s.mrr <= 0 || s.status === "canceled") continue
    if (!s.current_period_start || !s.current_period_end) continue
    const number = `INV-${s.tenant_id}-${String(s.current_period_start).replace(/-/g, "").slice(0, 6)}`
    await query(
      `INSERT INTO \`platform_invoices\`
         (\`tenant_id\`, \`invoice_number\`, \`amount\`, \`currency\`, \`status\`, \`period_start\`, \`period_end\`, \`issued_at\`)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`amount\` = VALUES(\`amount\`)`,
      [s.tenant_id, number, s.mrr, s.currency, s.current_period_start, s.current_period_end, s.current_period_start],
    )
  }
}

export async function listInvoices(): Promise<InvoiceWithTenant[]> {
  await ensureCurrentInvoices()
  const rows = await query<any[]>(
    `SELECT i.*, t.name AS tenant_name
       FROM \`platform_invoices\` i
       JOIN \`tenants\` t ON t.id = i.tenant_id
      ORDER BY i.issued_at DESC, i.id DESC
      LIMIT 200`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    tenant_name: r.tenant_name,
    invoice_number: r.invoice_number,
    amount: Number(r.amount),
    currency: r.currency,
    status: r.status,
    period_start: r.period_start,
    period_end: r.period_end,
    issued_at: r.issued_at,
    paid_at: r.paid_at,
  }))
}

export async function markInvoicePaid(invoiceId: number): Promise<void> {
  await ensurePlatformConsoleSchema()
  await query("UPDATE `platform_invoices` SET `status` = 'paid', `paid_at` = ? WHERE `id` = ? AND `status` = 'open'", [
    iso(new Date()),
    invoiceId,
  ])
}

let refundSchemaEnsured: Promise<void> | null = null

/** Spec29: cumulative refund tracking on platform invoices (+ idempotent refund log). */
export async function ensureInvoiceRefundSchema(): Promise<void> {
  if (!refundSchemaEnsured) {
    refundSchemaEnsured = (async () => {
      await ensurePlatformConsoleSchema()
      await ensureColumn("platform_invoices", "refunded_amount", "DECIMAL(12,2) NOT NULL DEFAULT 0")
      await ensureColumn("platform_invoices", "refunded_at", "DATETIME DEFAULT NULL")
      await query(`
        CREATE TABLE IF NOT EXISTS \`platform_invoice_refunds\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`invoice_id\` INT UNSIGNED NOT NULL,
          \`amount\` DECIMAL(12,2) NOT NULL,
          \`reason\` VARCHAR(300) DEFAULT NULL,
          \`idempotency_key\` VARCHAR(100) NOT NULL,
          \`created_by\` INT UNSIGNED DEFAULT NULL,
          \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uniq_inv_refund_idem\` (\`idempotency_key\`),
          KEY \`idx_inv_refund_invoice\` (\`invoice_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `)
    })().catch((err) => {
      refundSchemaEnsured = null
      throw err
    })
  }
  return refundSchemaEnsured
}

export class InvoiceRefundError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/**
 * Refund (part of) a PAID platform invoice. Idempotent on `idempotencyKey`:
 * replaying the same key returns the original refund without refunding twice.
 * The cumulative refund can never exceed the invoice amount (row-locked).
 */
export async function refundInvoice(input: {
  invoiceId: number
  amountCents: number
  reason: string | null
  idempotencyKey: string
  actorUserId: number
}): Promise<{ replayed: boolean; refundedAmount: string; tenantId: number }> {
  await ensureInvoiceRefundSchema()
  const { withTransaction } = await import("@/lib/db")
  return withTransaction(async (conn) => {
    const [existing]: any = await conn.query(
      "SELECT `invoice_id` FROM `platform_invoice_refunds` WHERE `idempotency_key` = ? LIMIT 1",
      [input.idempotencyKey],
    )
    const [invRows]: any = await conn.query(
      "SELECT `id`, `tenant_id`, `amount`, `refunded_amount`, `status` FROM `platform_invoices` WHERE `id` = ? FOR UPDATE",
      [input.invoiceId],
    )
    const inv = invRows?.[0]
    if (!inv) throw new InvoiceRefundError("Invoice not found", 404)
    if (existing?.[0]) {
      if (Number(existing[0].invoice_id) !== input.invoiceId) {
        throw new InvoiceRefundError("Idempotency key already used for another invoice", 409)
      }
      return { replayed: true, refundedAmount: String(inv.refunded_amount), tenantId: Number(inv.tenant_id) }
    }
    if (inv.status !== "paid") throw new InvoiceRefundError("Only paid invoices can be refunded", 409)
    const amountCents = Math.round(Number(inv.amount) * 100)
    const refundedCents = Math.round(Number(inv.refunded_amount ?? 0) * 100)
    if (refundedCents + input.amountCents > amountCents) {
      throw new InvoiceRefundError("Refund exceeds the remaining paid amount", 409)
    }
    const amount = (input.amountCents / 100).toFixed(2)
    await conn.query(
      "INSERT INTO `platform_invoice_refunds` (`invoice_id`, `amount`, `reason`, `idempotency_key`, `created_by`) VALUES (?, ?, ?, ?, ?)",
      [input.invoiceId, amount, input.reason, input.idempotencyKey, input.actorUserId],
    )
    const next = ((refundedCents + input.amountCents) / 100).toFixed(2)
    await conn.query("UPDATE `platform_invoices` SET `refunded_amount` = ?, `refunded_at` = ? WHERE `id` = ?", [
      next,
      new Date().toISOString().slice(0, 19).replace("T", " "),
      input.invoiceId,
    ])
    return { replayed: false, refundedAmount: next, tenantId: Number(inv.tenant_id) }
  })
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export async function listFeatureFlags(): Promise<FeatureFlag[]> {
  await ensurePlatformConsoleSchema()
  const rows = await query<any[]>(
    `SELECT f.*, (
       SELECT COUNT(*) FROM \`platform_feature_flag_overrides\` o WHERE o.flag_key = f.flag_key
     ) AS override_count
       FROM \`platform_feature_flags\` f
      ORDER BY f.name ASC`,
  )
  return rows.map((r) => ({
    key: r.flag_key,
    name: r.name,
    description: r.description,
    enabled: Boolean(r.enabled),
    rollout_percentage: Number(r.rollout_percentage),
    updated_at: r.updated_at,
    override_count: Number(r.override_count),
  }))
}

export async function upsertFeatureFlag(input: {
  key: string
  name: string
  description?: string | null
  enabled: boolean
  rollout_percentage: number
}): Promise<void> {
  await ensurePlatformConsoleSchema()
  const key = input.key.toLowerCase().trim()
  if (!/^[a-z0-9_]{2,60}$/.test(key)) throw new Error("Flag key must be 2-60 chars: lowercase letters, digits or _")
  if (!input.name?.trim()) throw new Error("Flag name is required")
  const pct = Math.max(0, Math.min(100, Math.round(input.rollout_percentage)))
  await query(
    `INSERT INTO \`platform_feature_flags\` (\`flag_key\`, \`name\`, \`description\`, \`enabled\`, \`rollout_percentage\`)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       \`name\` = VALUES(\`name\`), \`description\` = VALUES(\`description\`),
       \`enabled\` = VALUES(\`enabled\`), \`rollout_percentage\` = VALUES(\`rollout_percentage\`)`,
    [key, input.name.trim(), input.description ?? null, input.enabled ? 1 : 0, pct],
  )
}

export async function setFeatureFlagEnabled(key: string, enabled: boolean): Promise<void> {
  await ensurePlatformConsoleSchema()
  await query("UPDATE `platform_feature_flags` SET `enabled` = ? WHERE `flag_key` = ?", [enabled ? 1 : 0, key])
}

// ---------------------------------------------------------------------------
// Platform configuration
// ---------------------------------------------------------------------------

export async function listConfig(): Promise<PlatformConfigEntry[]> {
  await ensurePlatformConsoleSchema()
  const rows = await query<any[]>("SELECT * FROM `platform_config` ORDER BY `category` ASC, `config_key` ASC")
  return rows.map((r) => ({
    config_key: r.config_key,
    config_value: r.is_secret ? null : r.config_value,
    category: r.category,
    description: r.description,
    is_secret: Boolean(r.is_secret),
    updated_at: r.updated_at,
  }))
}

export async function setConfigValue(key: string, value: string): Promise<void> {
  await ensurePlatformConsoleSchema()
  const rows = await query<any[]>("SELECT `is_secret` FROM `platform_config` WHERE `config_key` = ? LIMIT 1", [key])
  if (rows.length === 0) throw new Error(`Unknown config key "${key}"`)
  await query("UPDATE `platform_config` SET `config_value` = ? WHERE `config_key` = ?", [value, key])
}
