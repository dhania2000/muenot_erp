/**
 * SPEC 2 — Tenant-owned entity registry (single source of truth).
 * ---------------------------------------------------------------------------
 * A table is "tenant-owned" when its rows belong to exactly one customer
 * organization and must never be visible to another. This registry is the ONE
 * place that enumerates those tables. It drives three things so they can never
 * drift apart:
 *
 *   1. The isolation migration + runtime self-heal (add `tenant_id`, index, FK).
 *   2. The fail-closed data-layer guard (lib/tenant-guard.ts) that rejects /
 *      reports any query touching one of these tables without a tenant filter.
 *   3. The tenant-scoped query helpers (lib/tenant-scope.ts).
 *
 * Extending isolation to a new entity is intentionally a one-line change here:
 * add the table name and the migration, self-heal, guard, and helpers all pick
 * it up automatically.
 *
 * NOT tenant-owned (deliberately excluded):
 *   - `tenants`                     : the tenant directory itself.
 *   - `users`                       : already carries tenant_id (SPEC 1) and is
 *                                     scoped by the auth layer, but is listed in
 *                                     TENANT_SCOPED_IDENTITY below so the guard
 *                                     still protects direct user reads.
 *   - `modules` / `features`        : global catalog shared by every tenant.
 *   - `environment_variables`       : platform-level configuration.
 *   - `information_schema.*`         : never guarded.
 */

/** The tenant discriminator column used across the app. */
export const TENANT_COLUMN = "tenant_id"

/**
 * Core tenant-owned business tables. These receive a `tenant_id` column, a
 * covering index, and a foreign key to `tenants(id)`, and are enforced by the
 * data-layer guard.
 *
 * Kept to entities whose schema is verified (database/schema.sql) or that
 * self-heal at runtime (lib/clients-db.ts). Adding more is a one-line change.
 */
export const TENANT_OWNED_TABLES = [
  // Sales CRM
  "sales_leads",
  "sales_companies",
  "sales_meetings",
  "sales_quotations",
  "sales_contracts",
  "sales_onboarding",
  "sales_revenue_forecast",
  // Clients master
  "clients",
  // Organization hierarchy (SPEC 6)
  "org_units",
  "org_unit_assignments",
  "org_unit_change_log",
  // Multi-entity support (SPEC 7)
  "legal_entities",
  "legal_entity_bank_accounts",
  "intercompany_transactions",
  // SaaS subscription engine (SPEC 16)
  "saas_subscriptions",
  "saas_subscription_events",
  // Usage metering (SPEC 19)
  "usage_events",
  "usage_daily",
  "usage_limits",
  // Billing engine (SPEC 20)
  "billing_invoices",
  "billing_invoice_lines",
  "billing_coupons",
  "billing_credits",
  "billing_payments",
  "billing_refunds",
  "billing_reconciliation",
  // Payment gateway abstraction (SPEC 21) — inbound webhook idempotency ledger
  "billing_gateway_events",
  // Renewal management (SPEC 24)
  "saas_renewal_reminders",
  "saas_renewal_attempts",
  // Customer-owned storage (SPEC 26) — each tenant's storage backend + creds
  "tenant_storage_connections",
  "tenant_storage_audit",
  // Large / resumable uploads (SPEC 30) — multipart session + per-chunk ledger
  "storage_upload_sessions",
  "storage_upload_parts",
  // Centralized file metadata (SPEC 32) — one normalized row per stored file
  "file_objects",
  // File / document version audit trail (SPEC 33)
  "file_version_audit",
  // Malware / file-security scan state (SPEC 34)
  "file_security_scans",
  // Tenant storage quotas (SPEC 35) — custom quota / threshold / hard-limit config
  "storage_quota_settings",
  // Storage → Migration — module/sub-module data mapped to a storage folder
  "tenant_storage_migrations",
  // Configurable storage retention (SPEC 36) — default rule + per-module overrides
  "storage_retention_settings",
  "storage_retention_rules",
  // WhatsApp Business platform (SPEC — multi-tenant WhatsApp isolation).
  // Each tenant connects its own WhatsApp Business number(s); every row below
  // belongs to exactly one tenant and must never be visible to another.
  "marketing_whatsapp_integration",
  "marketing_whatsapp_contacts",
  "marketing_whatsapp_conversations",
  "marketing_whatsapp_messages",
  "marketing_whatsapp_webhook_events",
  "marketing_whatsapp_assignments",
  "marketing_whatsapp_departments",
  "marketing_whatsapp_department_agents",
  "marketing_whatsapp_agent_settings",
  "marketing_whatsapp_internal_notes",
  "marketing_whatsapp_transfers",
  "marketing_whatsapp_media",
  "marketing_whatsapp_templates",
  "marketing_whatsapp_audiences",
  "marketing_whatsapp_campaigns",
  "marketing_whatsapp_campaign_recipients",
  "marketing_whatsapp_campaign_events",
  "marketing_whatsapp_automations",
  // Template version history — each tenant's approved/edited template revisions.
  "marketing_whatsapp_template_versions",
  // Delivery diagnostics / send-failure ledger — per-tenant send outcomes.
  "marketing_whatsapp_diagnostics",
] as const

export type TenantOwnedTable = (typeof TENANT_OWNED_TABLES)[number]

/**
 * Identity tables that already carry `tenant_id` from SPEC 1. The guard also
 * protects these, but the migration does NOT try to add the column (SPEC 1
 * owns it).
 */
export const TENANT_SCOPED_IDENTITY = ["users"] as const

/** Every table the guard should protect (owned business tables + identity). */
export const ALL_TENANT_SCOPED_TABLES: readonly string[] = [
  ...TENANT_OWNED_TABLES,
  ...TENANT_SCOPED_IDENTITY,
]

const OWNED = new Set<string>(TENANT_OWNED_TABLES)
const SCOPED = new Set<string>(ALL_TENANT_SCOPED_TABLES)

/** True when the table gets a tenant_id column from the isolation migration. */
export function isTenantOwnedTable(table: string): boolean {
  return OWNED.has(table.toLowerCase())
}

/** True when the guard must enforce a tenant predicate on the table. */
export function isTenantScopedTable(table: string): boolean {
  return SCOPED.has(table.toLowerCase())
}
