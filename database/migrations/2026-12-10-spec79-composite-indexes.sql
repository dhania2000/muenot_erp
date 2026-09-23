-- =============================================================
-- SPEC 79 — Database performance: composite indexes for hot
-- tenant-scoped access patterns (additive, non-destructive).
-- -------------------------------------------------------------
-- Every tenant-scoped list query emits `WHERE tenant_id = ? ...` and almost
-- always adds `ORDER BY created_at DESC LIMIT n` (see lib/tenant-scope.ts
-- tenantSelect) or a `status = ?` filter. The original isolation migration
-- (2026-11-07) only created a SINGLE-column `(tenant_id)` index on the early
-- CRM/billing tables, so MySQL filters by tenant and then does a filesort per
-- page, and status filters fall back to a range scan of the whole tenant.
--
-- This migration adds the missing COMPOSITE indexes so those queries are
-- served index-ordered (no filesort) and status filters are covered:
--
--     (tenant_id, created_at)   -> index-ordered pagination
--     (tenant_id, status)       -> status-filtered lists / dashboards
--
-- Newer modules (usage_events, notification_deliveries, shopkeeper_*, storage,
-- email engine, background jobs, approvals, audit retention, legal holds,
-- employee-user link) already ship composite indexes and are intentionally
-- NOT touched here.
--
-- SAFE TO RE-RUN. `__idx_add_key` checks information_schema first (MySQL 8 has
-- no reliable ADD KEY IF NOT EXISTS) and skips a table/column that does not
-- exist, so partial / older installs apply whatever is applicable and never
-- error. No data is read or moved; adding a secondary index is an online
-- operation in InnoDB (ALGORITHM=INPLACE).
-- =============================================================

SET NAMES utf8mb4;

DELIMITER $$

-- Add `p_key` on `p_table` only when: the table exists, every indexed column
-- exists, and the index name is not already present. `p_second_col` is the
-- column whose existence is not guaranteed on older installs (tenant_id itself
-- is guaranteed by the isolation migration / runtime self-heal); pass '' to
-- skip the column check.
DROP PROCEDURE IF EXISTS `__idx_add_key` $$
CREATE PROCEDURE `__idx_add_key`(
  IN p_table VARCHAR(64),
  IN p_key VARCHAR(64),
  IN p_second_col VARCHAR(64),
  IN p_ddl TEXT
)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = p_table)
     AND (p_second_col = '' OR EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = p_table
               AND column_name = p_second_col))
     AND NOT EXISTS (SELECT 1 FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = p_table
               AND index_name = p_key) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl, ', ALGORITHM=INPLACE, LOCK=NONE');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- --- Sales CRM ------------------------------------------------------------
CALL `__idx_add_key`('sales_leads',            'idx_sales_leads_tenant_created',            'created_at', 'KEY `idx_sales_leads_tenant_created` (`tenant_id`, `created_at`)');
CALL `__idx_add_key`('sales_leads',            'idx_sales_leads_tenant_status',             'status',     'KEY `idx_sales_leads_tenant_status` (`tenant_id`, `status`)');
CALL `__idx_add_key`('sales_companies',        'idx_sales_companies_tenant_created',        'created_at', 'KEY `idx_sales_companies_tenant_created` (`tenant_id`, `created_at`)');
CALL `__idx_add_key`('sales_meetings',         'idx_sales_meetings_tenant_created',         'created_at', 'KEY `idx_sales_meetings_tenant_created` (`tenant_id`, `created_at`)');
CALL `__idx_add_key`('sales_meetings',         'idx_sales_meetings_tenant_status',          'status',     'KEY `idx_sales_meetings_tenant_status` (`tenant_id`, `status`)');
CALL `__idx_add_key`('sales_quotations',       'idx_sales_quotations_tenant_created',       'created_at', 'KEY `idx_sales_quotations_tenant_created` (`tenant_id`, `created_at`)');
CALL `__idx_add_key`('sales_quotations',       'idx_sales_quotations_tenant_status',        'status',     'KEY `idx_sales_quotations_tenant_status` (`tenant_id`, `status`)');
CALL `__idx_add_key`('sales_contracts',        'idx_sales_contracts_tenant_created',        'created_at', 'KEY `idx_sales_contracts_tenant_created` (`tenant_id`, `created_at`)');
CALL `__idx_add_key`('sales_contracts',        'idx_sales_contracts_tenant_status',         'status',     'KEY `idx_sales_contracts_tenant_status` (`tenant_id`, `status`)');
CALL `__idx_add_key`('sales_onboarding',       'idx_sales_onboarding_tenant_created',       'created_at', 'KEY `idx_sales_onboarding_tenant_created` (`tenant_id`, `created_at`)');
CALL `__idx_add_key`('sales_revenue_forecast', 'idx_sales_revenue_forecast_tenant_created', 'created_at', 'KEY `idx_sales_revenue_forecast_tenant_created` (`tenant_id`, `created_at`)');

-- --- Clients master -------------------------------------------------------
CALL `__idx_add_key`('clients', 'idx_clients_tenant_created', 'created_at', 'KEY `idx_clients_tenant_created` (`tenant_id`, `created_at`)');
CALL `__idx_add_key`('clients', 'idx_clients_tenant_status',  'status',     'KEY `idx_clients_tenant_status` (`tenant_id`, `status`)');

-- --- Billing --------------------------------------------------------------
-- billing_invoices had only single-column (tenant_id) + (status); dashboards
-- list a tenant's invoices by status and by recency, and dun overdue ones by
-- due_date, so cover all three within the tenant.
CALL `__idx_add_key`('billing_invoices', 'idx_billing_invoices_tenant_status',  'status',     'KEY `idx_billing_invoices_tenant_status` (`tenant_id`, `status`)');
CALL `__idx_add_key`('billing_invoices', 'idx_billing_invoices_tenant_created', 'created_at', 'KEY `idx_billing_invoices_tenant_created` (`tenant_id`, `created_at`)');
CALL `__idx_add_key`('billing_invoices', 'idx_billing_invoices_tenant_due',     'due_date',   'KEY `idx_billing_invoices_tenant_due` (`tenant_id`, `due_date`)');

-- --- WhatsApp (highest write volume) --------------------------------------
-- Thread view pages messages oldest/newest within a conversation; the inbox
-- lists a tenant's recent messages. tenant_id is added by the isolation
-- migration; conversation_id is native to the table.
CALL `__idx_add_key`('marketing_whatsapp_messages', 'idx_wa_message_tenant_created', 'created_at',      'KEY `idx_wa_message_tenant_created` (`tenant_id`, `created_at`)');
CALL `__idx_add_key`('marketing_whatsapp_messages', 'idx_wa_message_convo_created',  'conversation_id', 'KEY `idx_wa_message_convo_created` (`conversation_id`, `created_at`)');
CALL `__idx_add_key`('marketing_whatsapp_conversations', 'idx_wa_convo_tenant_updated', 'updated_at',  'KEY `idx_wa_convo_tenant_updated` (`tenant_id`, `updated_at`)');

DROP PROCEDURE IF EXISTS `__idx_add_key`;
