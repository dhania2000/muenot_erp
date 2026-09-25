/**
 * Tenant-owned entity registry (single source of truth).
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
 * - `users` : already carries tenant_id and is
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
  // Organization hierarchy
  "org_units",
  "org_unit_assignments",
  "org_unit_change_log",
  // Multi-entity support
  "legal_entities",
  "legal_entity_bank_accounts",
  "intercompany_transactions",
  // SaaS subscription engine
  "saas_subscriptions",
  "saas_subscription_events",
  // Usage metering
  "usage_events",
  "usage_daily",
  "usage_limits",
  // Usage-based billing (Spec 5) — per-tenant plan allowances / overage rates
  // and the reconciliation ledger that guarantees one invoice line per metric
  // per billing period with no double charging.
  "usage_allowances",
  "usage_billing_ledger",
  // Billing engine
  "billing_invoices",
  "billing_invoice_lines",
  "billing_coupons",
  "billing_credits",
  "billing_payments",
  "billing_refunds",
  "billing_reconciliation",
  // Payment gateway abstraction — inbound webhook idempotency ledger
  "billing_gateway_events",
  // SaaS accounting (Spec 6) — the platform seller ledger and deferred revenue.
  // Kept separate from each customer's own ERP finance ledger.
  "platform_journal",
  "platform_journal_lines",
  "deferred_revenue_schedules",
  "deferred_revenue_entries",
  "deferred_revenue_reversals",
  // Session-route idempotency (Idempotency-Key on billing money actions)
  "billing_request_idempotency",
  // Renewal management
  "saas_renewal_reminders",
  "saas_renewal_attempts",
  // Customer-owned storage — each tenant's storage backend + creds
  "tenant_storage_connections",
  "tenant_storage_audit",
  // Large / resumable uploads — multipart session + per-chunk ledger
  "storage_upload_sessions",
  "storage_upload_parts",
  // Centralized file metadata — one normalized row per stored file
  "file_objects",
  // File / document version audit trail
  "file_version_audit",
  // Malware / file-security scan state
  "file_security_scans",
  // Tenant storage quotas — custom quota / threshold / hard-limit config
  "storage_quota_settings",
  // Storage → Migration — module/sub-module data mapped to a storage folder
  "tenant_storage_migrations",
  // Configurable storage retention — default rule + per-module overrides
  "storage_retention_settings",
  "storage_retention_rules",
  // SPEC 86 — centralized Document Management System. Business layer that sits
  // on top of file_objects: documents, folder tree, categories, tags, per
  // subject permissions, share links, approval workflow and an audit trail.
  "dms_folders",
  "dms_categories",
  "dms_tags",
  "dms_documents",
  "dms_document_tags",
  "dms_document_permissions",
  "dms_document_shares",
  "dms_audit",
  // Canonical tenant configuration and its append-only change history
  //. These replace the legacy global company_settings writes while
  // keeping the legacy table available as an inherited platform baseline.
  "tenant_settings",
  "tenant_settings_audit",
  // Reusable workflow definitions, execution history and owned task records.
  "erp_workflows",
  "erp_workflow_runs",
  "erp_workflow_events",
  "erp_workflow_notices",
  "erp_workflow_tasks",
  "erp_business_events",
  "erp_event_subscriptions",
  "erp_event_deliveries",
  "erp_event_delivery_log",
  "notification_templates",
  "notification_preferences",
  "notification_deliveries",
  "notification_delivery_log",
  // Session-wise inactivity tied to an existing attendance row.
  "hr_attendance_idle_sessions",
  // WhatsApp Business platform (SPEC — multi-tenant WhatsApp isolation).
  // Each tenant connects its own WhatsApp Business number(s); every row below
  // belongs to exactly one tenant and must never be visible to another.
  "marketing_whatsapp_integration",
  "marketing_whatsapp_registration",
  "marketing_whatsapp_signup_progress",
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
  "marketing_whatsapp_template_versions",
  "marketing_whatsapp_audiences",
  "marketing_whatsapp_campaigns",
  "marketing_whatsapp_campaign_recipients",
  "marketing_whatsapp_campaign_events",
  "marketing_whatsapp_automations",
  "marketing_whatsapp_diagnostics",
  // Server-side session store + SSO identity providers.
  "user_sessions",
  "sso_providers",
  "sso_login_events",
  // SPEC 157 — Custom Domain. Each tenant's own domains (erp.customer.com),
  // their verification/activation state and ownership tokens. A domain belongs
  // to exactly one tenant (hostname is globally UNIQUE) and must never be
  // visible to, verified or activated by another.
  "tenant_domains",
  // API key platform + webhook delivery engine.
  "api_keys",
  "api_rate_limit_policies",
  "api_rate_limit_counters",
  "api_rate_limit_abuse",
  "webhook_endpoints",
  "webhook_deliveries",
  // Shopkeeper mobile clients / profile. Device registrations are only a
  // server-side future FCM boundary; Firebase credentials never live here.
  "shopkeeper_profiles",
  "mobile_sessions",
  "mobile_device_registrations",
  "mobile_api_audit",
  // Shopkeeper shop domain. Deliberately separate from the global ERP
  // `products` / `sales_invoices` tables, which carry no tenant_id.
  "shopkeeper_products",
  "shopkeeper_orders",
  "shopkeeper_order_items",
  // SPEC 90 — Centralized Master Data. Tenant-owned business masters. The geo /
  // currency / unit reference catalogue (md_countries, md_states, md_cities,
  // md_currencies, md_units, md_payment_terms, md_approval_levels) is a global
  // shared catalogue like modules/features and is deliberately NOT listed here.
  "md_cost_centers",
  "md_locations",
  "md_categories",
  // SPEC 91 — Master Data Governance. Maker/checker workflow, ownership and
  // append-only change history for critical masters. Tenant-owned: each tenant
  // governs and approves its own master values independently.
  "md_gov_records",
  "md_gov_change_requests",
  "md_gov_history",
  // SPEC 92 — Numbering Engine. Per-tenant, per-entity numbering rules and the
  // running sequence counters they draw from. Each tenant configures and
  // consumes its own numbering streams; a counter must never be visible to or
  // shared with another tenant.
  "numbering_rules",
  "numbering_counters",
  // SPEC 93 — Reference Number Management. Per-tenant configuration of which
  // reference numbers each business document carries and how duplicates are
  // handled, plus the captured reference values themselves. Each tenant's
  // references and duplicate scope are fully isolated from every other tenant.
  "reference_configs",
  "document_references",
  // SPEC 94 — Custom Fields. Tenant-defined, metadata-driven fields that extend
  // any module's records without code changes, plus the per-record values they
  // capture. Both a tenant's field DEFINITIONS and the captured VALUES are fully
  // isolated from every other tenant.
  "custom_field_defs",
  "custom_field_values",
  // SPEC 135 — Goal / KPI Engine. Per-tenant KPI/goal definitions and their
  // append-only progress check-ins. Every goal and check-in belongs to exactly
  // one tenant and must never be visible to another.
  "kpi_goals",
  "kpi_checkins",
  // SPEC 95 — Custom Forms. Tenant-authored, metadata-driven data-entry forms
  // (sections, fields, conditional rules, approval config) and the submissions
  // captured against them. A tenant's form DEFINITIONS and the SUBMISSIONS are
  // fully isolated from every other tenant.
  "custom_forms",
  "custom_form_submissions",
  // SPEC 96 — Custom Module Framework. Tenant-created lightweight modules: a
  // metadata-driven entity DEFINITION (fields, list view, permissions, workflow,
  // reports) and the RECORDS captured against it in a single generic record
  // table discriminated by module id. A tenant's module definitions and records
  // are fully isolated from every other tenant — the record table is always
  // filtered by both tenant_id and module_id.
  "custom_modules",
  "custom_module_records",
  // SPEC 103 — Duplicate Detection. Tenant-owned review/merge workflow for the
  // fuzzy-matching framework: detected duplicate PAIRS awaiting review and an
  // append-only MERGE LOG. Each tenant reviews and merges only its own records;
  // a candidate pair or merge audit row is never visible to another tenant.
  "dup_candidates",
  "dup_merge_log",
  // SPEC 110 — Centralized Task Engine. A single tenant-owned task backbone any
  // module can create work against, with dependencies, checklist items,
  // comments, attachments, recurrence and an approval workflow. Every row
  // belongs to exactly one tenant and is never visible to another.
  "tasks",
  "task_dependencies",
  "task_checklist_items",
  "task_comments",
  "task_attachments",
  "task_activity",
  // SPEC 112 — Meeting Management. A tenant-owned general meeting engine with
  // participants, agenda, attachments, notes, action items, follow-ups and an
  // immutable change history. Every row belongs to exactly one tenant.
  "meetings",
  "meeting_participants",
  "meeting_agenda_items",
  "meeting_attachments",
  "meeting_notes",
  "meeting_action_items",
  "meeting_followups",
  "meeting_history",
  // SPEC 118 — Client Portal. External-facing, tenant + client isolated. Each
  // row belongs to exactly one tenant AND one client; the store layer
  // (lib/portal/store.ts) additionally constrains client_id on every query so
  // one client can never see another client's data within the same tenant.
  "client_portal_users",
  "client_portal_access",
  "client_portal_items",
  "client_portal_tickets",
  "client_portal_ticket_messages",
  "client_portal_messages",
  // SPEC 119 — Vendor Portal. External-facing, tenant + vendor isolated. Each
  // row belongs to exactly one tenant AND one vendor; the store layer
  // (lib/vendor-portal/store.ts) additionally constrains vendor_id on every
  // query so one vendor can never see another vendor's data within a tenant.
  "vendor_portal_users",
  "vendor_portal_access",
  "vendor_portal_items",
  "vendor_portal_messages",
  // SPEC 159 — Multi-Currency. Per-tenant exchange-rate history (QUOTE->BASE,
  // one row per pair per date) and the FX gain/loss ledger. Each tenant
  // maintains and converts against its own rates; a rate or gain/loss row is
  // never visible to another tenant.
  "currency_exchange_rates",
  "currency_fx_gain_loss",
  // SPEC 9 — External Secrets Vault providers. A tenant's OWN integration
  // credentials (Stripe/SMTP/Twilio/…) scoped SEPARATELY from platform secrets:
  // the per-integration health/vault row, the append-only encrypted version
  // history (external-vault handle or DB ciphertext), the access audit trail,
  // and the write idempotency ledger. Every row belongs to exactly one tenant
  // and a credential must never be visible to, resolved by, or rotated from
  // another tenant.
  "tenant_integration_secrets",
  "tenant_integration_secret_versions",
  "tenant_integration_secret_audit",
  "tenant_integration_secret_idempotency",
  // SPEC 15 — Integration marketplace (#88-89). Installable connectors (Tally,
  // Zoho, Microsoft, Google, Slack): the per-connector install/health row, the
  // encrypted-at-rest credential store with active/revoked state, the lifecycle
  // audit trail, and the write idempotency ledger. Every row belongs to exactly
  // one tenant; a connector install or credential must never be visible to,
  // resolved by, reconnected or disconnected from another tenant.
  "tenant_connector_installations",
  "tenant_connector_credentials",
  "tenant_connector_audit",
  "tenant_connector_idempotency",
  // SPEC 16 — Integration sync & conflict resolution (#90-91). Per-tenant sync
  // connections (provider × entity), their run history with cursor checkpoints,
  // the normalized external↔master record mappings with baseline fingerprints,
  // detected conflict rows awaiting resolution, and the immutable, replay-safe
  // sync event log. Every row belongs to exactly one tenant; a connection, run,
  // mapping, conflict or log event must never be visible to another tenant.
  "integration_sync_connections",
  "integration_sync_runs",
  "integration_record_mappings",
  "integration_sync_conflicts",
  "integration_sync_log",
] as const

export type TenantOwnedTable = (typeof TENANT_OWNED_TABLES)[number]

/**
 * Identity tables that already carry `tenant_id` from. The guard also
 * protects these, but the migration does NOT try to add the column (
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
