-- Spec62 — Platform identity & finance boundary (#242-244)
-- ---------------------------------------------------------------------------
-- Materializes the incremental schema that the platform role / audit and the
-- platform seller ledger services self-heal at runtime, so fresh installs get
-- it directly and existing installs converge on first use. Safe to re-run.
--
-- Context (unchanged, re-stated for the boundary this spec finalizes):
--   * platform identity lives on `users.platform_role` / `users.tenant_role`
--     and the Muenot ERP tenant is flagged by `tenants.is_platform_owner`
--     (see 2026-11-08-platform-tenant-roles.sql).
--   * platform operator actions are audited in `platform_admin_audit` — a store
--     that is SEPARATE from any customer tenant's own audit log.
--   * SaaS seller money lives in `platform_journal` / `platform_journal_lines`
--     (see 2027-01-03-spec6-saas-tax-revenue-accounting.sql) and must NEVER
--     post into a customer's `general_ledger` / `journal_entries`. The guard in
--     lib/billing/finance-boundary.ts enforces this at the posting seam.
--
-- This migration only adds a composite index that supports tenant-scoped
-- audit-separation queries; no table shape changes.

-- Fast lookup of "every platform action taken against tenant X", used to prove
-- audit separation (platform trail vs. the customer's own audit log).
ALTER TABLE `platform_admin_audit`
  ADD KEY IF NOT EXISTS `idx_paa_target_tenant_action` (`target_tenant_id`, `action`);
