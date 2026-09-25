/**
 * Spec26 — Demo tenant & cloning (#121-122): pure, DB-free logic.
 * ---------------------------------------------------------------------------
 * This module holds everything about demo tenants that does NOT need a database
 * so it can be unit-tested directly (mirroring lib/*-core / *-model in the rest
 * of the codebase):
 *
 *   - the SAFETY denylist of tenant-owned tables that must NEVER be cloned into
 *     a demo tenant (secrets, integrations, payment/billing, sessions, …),
 *   - the curated allowlist of demo-safe tables the clone engine copies, plus a
 *     defense-in-depth assertion that the two never overlap,
 *   - input normalization / validation for a clone request (label + TTL),
 *   - expiry math (compute / is-expired / days-remaining),
 *   - deterministic regeneration of globally-unique columns so a cloned row can
 *     never collide with the template's or another clone's unique keys,
 *   - the synthetic seed dataset for the template (realistic but fake).
 *
 * The store (lib/demo-tenant-store.ts) owns all SQL and wiring.
 */
import { isTenantOwnedTable } from "@/lib/tenant-tables"

// ---------------------------------------------------------------------------
// Kinds / statuses
// ---------------------------------------------------------------------------

export const DEMO_TENANT_KINDS = ["template", "clone"] as const
export type DemoTenantKind = (typeof DEMO_TENANT_KINDS)[number]

export const DEMO_TENANT_STATUSES = ["active", "expired", "cleaned"] as const
export type DemoTenantStatus = (typeof DEMO_TENANT_STATUSES)[number]

// ---------------------------------------------------------------------------
// Identity of the canonical template
// ---------------------------------------------------------------------------

export const DEMO_TEMPLATE_SLUG = "demo-template"
export const DEMO_TEMPLATE_NAME = "Muenot Demo (Template)"
export const DEMO_CLONE_SLUG_PREFIX = "demo"
/** Marker written onto a demo tenant's settings JSON so the tenant itself is self-describing. */
export const DEMO_SETTINGS_KEY = "demo"

// ---------------------------------------------------------------------------
// SAFETY — tables that must NEVER be copied into a demo tenant.
// ---------------------------------------------------------------------------
/**
 * Real customer data, secrets, third-party integrations, payment methods and
 * anything security/session-bearing. The clone engine only ever touches the
 * curated DEMO_CLONE_TABLES allowlist below, but this denylist is the explicit,
 * testable statement of intent AND a hard guard: assertDemoTablesSafe() refuses
 * to run if the allowlist ever intersects it.
 */
export const DEMO_CLONE_DENYLIST: readonly string[] = [
  // External secrets vault
  "tenant_integration_secrets",
  "tenant_integration_secret_versions",
  "tenant_integration_secret_audit",
  "tenant_integration_secret_idempotency",
  // Integration marketplace connectors + credentials
  "tenant_connector_installations",
  "tenant_connector_credentials",
  "tenant_connector_audit",
  "tenant_connector_idempotency",
  // Integration sync engine
  "integration_sync_connections",
  "integration_sync_runs",
  "integration_record_mappings",
  "integration_sync_conflicts",
  "integration_sync_log",
  // Payment / billing / money
  "billing_invoices",
  "billing_invoice_lines",
  "billing_coupons",
  "billing_credits",
  "billing_payments",
  "billing_refunds",
  "billing_reconciliation",
  "billing_gateway_events",
  "billing_request_idempotency",
  "saas_subscriptions",
  "saas_subscription_events",
  "platform_journal",
  "platform_journal_lines",
  "deferred_revenue_schedules",
  "deferred_revenue_entries",
  "deferred_revenue_reversals",
  // Storage backends + credentials
  "tenant_storage_connections",
  "tenant_storage_audit",
  "storage_upload_sessions",
  "storage_upload_parts",
  // Sessions / identity / SSO
  "user_sessions",
  "sso_providers",
  "sso_login_events",
  // API keys / webhooks
  "api_keys",
  "api_rate_limit_policies",
  "api_rate_limit_counters",
  "api_rate_limit_abuse",
  "webhook_endpoints",
  "webhook_deliveries",
  // Mobile sessions / device registrations
  "mobile_sessions",
  "mobile_device_registrations",
  "mobile_api_audit",
  // WhatsApp Business (real external channel + real contact PII)
  "marketing_whatsapp_integration",
  "marketing_whatsapp_registration",
  "marketing_whatsapp_signup_progress",
  "marketing_whatsapp_contacts",
  "marketing_whatsapp_conversations",
  "marketing_whatsapp_messages",
  "marketing_whatsapp_webhook_events",
  "marketing_whatsapp_media",
  // Custom domains
  "tenant_domains",
]

const DENYSET = new Set(DEMO_CLONE_DENYLIST.map((t) => t.toLowerCase()))

/** True when the table is explicitly forbidden from being cloned. */
export function isDemoCloneDenied(table: string): boolean {
  return DENYSET.has(table.toLowerCase())
}

// ---------------------------------------------------------------------------
// Curated demo-safe tables the clone engine copies.
// ---------------------------------------------------------------------------
/**
 * Each entry names a tenant-owned business table and the columns that carry a
 * GLOBALLY-unique value (a unique key that is not scoped by tenant_id in the
 * schema). Those columns are regenerated per target tenant on copy so a clone
 * can never collide with the template or another clone.
 *
 * Kept intentionally small and correct: only independent master tables whose
 * rows reference nothing but the tenant, so a straight tenant_id remap is a
 * faithful copy. Extending the demo dataset to another such table is a one-line
 * addition here.
 */
export type DemoCloneTable = {
  table: string
  /** Globally-unique columns to regenerate on copy (e.g. business codes). */
  uniqueColumns: string[]
  /** Email-shaped columns to rewrite so cloned contacts are obviously synthetic. */
  emailColumns: string[]
}

export const DEMO_CLONE_TABLES: readonly DemoCloneTable[] = [
  { table: "clients", uniqueColumns: ["client_code"], emailColumns: ["email"] },
]

/**
 * Defense in depth. Throws if the curated allowlist ever names a denied table
 * or a table that is not tenant-owned (and therefore has no tenant_id to remap,
 * which would leak rows across tenants). Call once before any clone.
 */
export function assertDemoTablesSafe(): void {
  for (const { table } of DEMO_CLONE_TABLES) {
    if (isDemoCloneDenied(table)) {
      throw new Error(`Demo clone misconfigured: "${table}" is on the never-clone denylist`)
    }
    if (!isTenantOwnedTable(table)) {
      throw new Error(`Demo clone misconfigured: "${table}" is not a tenant-owned table`)
    }
  }
}

// ---------------------------------------------------------------------------
// Clone request input
// ---------------------------------------------------------------------------

export const MIN_TTL_DAYS = 1
export const MAX_TTL_DAYS = 90
export const DEFAULT_TTL_DAYS = 14
/** Upper bound on concurrently active clones — a runaway script cannot mint unbounded tenants. */
export const MAX_ACTIVE_DEMO_CLONES = 50

export type CloneInput = { label: string; ttlDays: number }

export function clampTtlDays(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_TTL_DAYS
  return Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, n))
}

/** Normalize an untrusted clone request body into a safe, bounded shape. */
export function normalizeCloneInput(input: unknown): CloneInput {
  const obj = (input ?? {}) as Record<string, unknown>
  const rawLabel = typeof obj.label === "string" ? obj.label.trim() : ""
  const label = (rawLabel || "Demo tenant").slice(0, 120)
  const ttlDays = obj.ttlDays === undefined || obj.ttlDays === null ? DEFAULT_TTL_DAYS : clampTtlDays(obj.ttlDays)
  return { label, ttlDays }
}

// ---------------------------------------------------------------------------
// Expiry math
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

export function computeExpiresAt(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + clampTtlDays(ttlDays) * DAY_MS)
}

/**
 * Parse a stored timestamp. The DB pool uses `dateStrings: true`, so DATETIMEs
 * arrive as naive "YYYY-MM-DD HH:MM:SS" strings; the store always writes them in
 * UTC (toSqlDatetime), so they are read back as UTC regardless of host timezone.
 */
export function parseDemoTime(value: string | Date | null | undefined): number {
  if (!value) return NaN
  if (value instanceof Date) return value.getTime()
  const s = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return Date.parse(`${s.replace(" ", "T")}Z`)
  return Date.parse(s)
}

/** UTC "YYYY-MM-DD HH:MM:SS" for DATETIME columns. */
export function toSqlDatetime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ")
}

export function isDemoExpired(expiresAt: string | Date | null, now: Date = new Date()): boolean {
  if (!expiresAt) return false
  const t = parseDemoTime(expiresAt)
  if (!Number.isFinite(t)) return false
  return t <= now.getTime()
}

export function demoDaysRemaining(expiresAt: string | Date | null, now: Date = new Date()): number {
  if (!expiresAt) return Infinity
  const t = parseDemoTime(expiresAt)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.ceil((t - now.getTime()) / DAY_MS))
}

/**
 * Validate an "extend by N days" request. Returns null for anything that is not
 * a whole number in [MIN_TTL_DAYS, MAX_TTL_DAYS] — extension is never silently
 * clamped because an operator typo should be rejected, not reinterpreted.
 */
export function parseExtendDays(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < MIN_TTL_DAYS || n > MAX_TTL_DAYS) return null
  return n
}

/**
 * New expiry after extending by `days`. Extends from the later of now and the
 * current expiry (so extending an already-expired clone restarts from now),
 * and is hard-capped at MAX_TTL_DAYS from now so repeated extensions can never
 * turn a demo into a permanent tenant.
 */
export function extendExpiry(current: string | Date | null, now: Date, days: number): Date {
  const cur = parseDemoTime(current)
  const base = Number.isFinite(cur) ? Math.max(cur, now.getTime()) : now.getTime()
  const cap = now.getTime() + MAX_TTL_DAYS * DAY_MS
  return new Date(Math.min(base + days * DAY_MS, cap))
}

// ---------------------------------------------------------------------------
// Demo marker + idempotency scoping
// ---------------------------------------------------------------------------

function parseSettings(settings: unknown): Record<string, any> | null {
  if (!settings) return null
  if (typeof settings === "object") return settings as Record<string, any>
  if (typeof settings === "string") {
    try {
      const parsed = JSON.parse(settings)
      return parsed && typeof parsed === "object" ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Hard guard for every destructive purge: true only when the tenant record
 * itself carries ALL the demo-clone markers (demo-* slug, demo plan, settings
 * marker, not the platform owner, not the template). A registry row alone is
 * never enough to authorize deleting a tenant.
 */
export function isDemoCloneTenantRecord(
  tenant: { slug?: string | null; plan?: string | null; settings?: unknown; is_platform_owner?: boolean | number | null } | null,
): boolean {
  if (!tenant) return false
  if (tenant.is_platform_owner) return false
  const slug = String(tenant.slug ?? "")
  if (slug === DEMO_TEMPLATE_SLUG || !slug.startsWith(`${DEMO_CLONE_SLUG_PREFIX}-`)) return false
  if (tenant.plan !== "demo") return false
  const marker = parseSettings(tenant.settings)?.[DEMO_SETTINGS_KEY]
  return !!marker && marker.role === "clone" && marker.synthetic === true
}

/**
 * Scope a client-supplied idempotency key to the acting operator so one
 * operator's key can never replay (and reveal) another operator's clone.
 * Returns null for a missing/blank key; rejects keys with unsafe characters.
 */
export function scopeIdempotencyKey(actorUserId: number, key: unknown): string | null {
  if (key === undefined || key === null) return null
  const trimmed = String(key).trim()
  if (!trimmed) return null
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(trimmed)) {
    throw new Error("Idempotency-Key must be 1-80 characters of letters, digits, '.', '_', ':' or '-'")
  }
  return `${actorUserId}:${trimmed}`
}

/**
 * Tables purged when a demo clone is cleaned up: EVERY tenant-owned table, not
 * just the seeded ones, because a demo user may have created invoices, leads,
 * etc. while exploring. Safe only because the purge is gated on
 * isDemoCloneTenantRecord() for a fully synthetic tenant. `users` is removed
 * afterwards by the shared deleteTenant() path.
 */
export function demoPurgeTables(ownedTables: readonly string[]): string[] {
  return ownedTables.filter((t) => t !== "users" && t !== "tenants")
}

// ---------------------------------------------------------------------------
// Unique-value regeneration
// ---------------------------------------------------------------------------
/**
 * Rewrite a globally-unique value so it is stable per target tenant but can
 * never collide with the source template or another clone. Emails get a
 * `+d<tenant>` sub-address (kept obviously synthetic); everything else gets a
 * `-D<tenant>` suffix. Deterministic, so re-running a reset for the same tenant
 * reproduces the same value.
 */
export function regenerateUniqueValue(original: unknown, tenantId: number): string {
  const base = original == null ? "" : String(original)
  if (base.includes("@")) {
    const [local, domain] = base.split("@")
    return `${local}+d${tenantId}@${domain || "demo.local"}`
  }
  return `${base}-D${tenantId}`
}

// ---------------------------------------------------------------------------
// Synthetic template dataset (realistic but entirely fabricated).
// ---------------------------------------------------------------------------
/**
 * Seeded into the template tenant's `clients` table. Field names match the
 * clients schema (lib/clients-db.ts). `tenant_id` is stamped by the store.
 */
export type DemoClientSeed = {
  client_code: string
  client_name: string
  email: string
  company_name: string
  mobile: string
  city: string
  state: string
  country: string
  currency: string
  category: string
  status: "Active" | "Inactive"
}

export const DEMO_CLIENT_SEED: readonly DemoClientSeed[] = [
  {
    client_code: "DEMO-CLI-001",
    client_name: "Aarav Mehta",
    email: "aarav.mehta@northwind-demo.test",
    company_name: "Northwind Traders (Demo)",
    mobile: "+91 90000 10001",
    city: "Mumbai",
    state: "Maharashtra",
    country: "India",
    currency: "INR",
    category: "Wholesale",
    status: "Active",
  },
  {
    client_code: "DEMO-CLI-002",
    client_name: "Priya Nair",
    email: "priya.nair@contoso-demo.test",
    company_name: "Contoso Retail (Demo)",
    mobile: "+91 90000 10002",
    city: "Bengaluru",
    state: "Karnataka",
    country: "India",
    currency: "INR",
    category: "Retail",
    status: "Active",
  },
  {
    client_code: "DEMO-CLI-003",
    client_name: "Daniel Rivera",
    email: "daniel.rivera@fabrikam-demo.test",
    company_name: "Fabrikam Logistics (Demo)",
    mobile: "+1 415 555 0103",
    city: "San Jose",
    state: "California",
    country: "United States",
    currency: "USD",
    category: "Enterprise",
    status: "Active",
  },
  {
    client_code: "DEMO-CLI-004",
    client_name: "Sofia Rossi",
    email: "sofia.rossi@tailspin-demo.test",
    company_name: "Tailspin Toys (Demo)",
    mobile: "+39 06 5550 104",
    city: "Rome",
    state: "Lazio",
    country: "Italy",
    currency: "EUR",
    category: "Retail",
    status: "Active",
  },
  {
    client_code: "DEMO-CLI-005",
    client_name: "Wei Chen",
    email: "wei.chen@wingtip-demo.test",
    company_name: "Wingtip Foods (Demo)",
    mobile: "+65 8000 0105",
    city: "Singapore",
    state: "Central",
    country: "Singapore",
    currency: "SGD",
    category: "Wholesale",
    status: "Inactive",
  },
  {
    client_code: "DEMO-CLI-006",
    client_name: "Fatima Al-Sayed",
    email: "fatima.alsayed@adventureworks-demo.test",
    company_name: "Adventure Works (Demo)",
    mobile: "+971 50 000 0106",
    city: "Dubai",
    state: "Dubai",
    country: "United Arab Emirates",
    currency: "AED",
    category: "Enterprise",
    status: "Active",
  },
]
