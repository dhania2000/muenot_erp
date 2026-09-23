-- =============================================================
-- Tenant data isolation (additive, non-destructive)
-- -------------------------------------------------------------
-- Adds the `tenant_id` discriminator, a covering index, and a foreign key to
-- every tenant-owned business table (see lib/tenant-tables.ts for the
-- authoritative registry). Existing rows are backfilled onto the default
-- platform-owner tenant (Muenot) so the current single-org install keeps
-- working unchanged.
--
-- Enforcement (rejecting cross-tenant reads/writes) is centralized in the
-- application data layer: lib/tenant-guard.ts inspects every query and
-- lib/tenant-scope.ts injects the tenant predicate. MySQL has no row-level
-- security, so the database side provides the columns, indexes, and referential
-- integrity that make that enforcement correct and fast.
--
-- SAFE TO RE-RUN. The same objects are also created idempotently at runtime by
-- ensureTenantIsolation() in lib/tenant-guard.ts, so existing databases
-- self-heal without a manual migration step. Column / key / FK changes go
-- through helper procedures that check information_schema first (MySQL 8 has no
-- reliable ADD ... IF NOT EXISTS).
-- =============================================================

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `__ti_add_column` $$
CREATE PROCEDURE `__ti_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__ti_add_key` $$
CREATE PROCEDURE `__ti_add_key`(IN p_table VARCHAR(64), IN p_key VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (SELECT 1 FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_key) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__ti_add_fk` $$
CREATE PROCEDURE `__ti_add_fk`(IN p_table VARCHAR(64), IN p_fk VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE table_schema = DATABASE() AND table_name = p_table
               AND constraint_name = p_fk AND constraint_type = 'FOREIGN KEY') THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD CONSTRAINT `', p_fk, '` ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- Add tenant_id + covering index per tenant-owned table (see
-- lib/tenant-tables.ts for the authoritative registry).
CALL `__ti_add_column`('sales_leads', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_leads', 'idx_sales_leads_tenant', 'KEY `idx_sales_leads_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_companies', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_companies', 'idx_sales_companies_tenant', 'KEY `idx_sales_companies_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_meetings', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_meetings', 'idx_sales_meetings_tenant', 'KEY `idx_sales_meetings_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_quotations', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_quotations', 'idx_sales_quotations_tenant', 'KEY `idx_sales_quotations_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_contracts', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_contracts', 'idx_sales_contracts_tenant', 'KEY `idx_sales_contracts_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_onboarding', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_onboarding', 'idx_sales_onboarding_tenant', 'KEY `idx_sales_onboarding_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_revenue_forecast', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_revenue_forecast', 'idx_sales_revenue_forecast_tenant', 'KEY `idx_sales_revenue_forecast_tenant` (`tenant_id`)');
CALL `__ti_add_column`('clients', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('clients', 'idx_clients_tenant', 'KEY `idx_clients_tenant` (`tenant_id`)');

-- Backfill every tenant-owned table onto the default (platform-owner) tenant.
UPDATE `sales_leads`            SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_companies`        SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_meetings`         SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_quotations`       SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_contracts`        SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_onboarding`       SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_revenue_forecast` SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `clients`                SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;

-- Referential integrity to the tenant directory.
CALL `__ti_add_fk`('sales_leads',            'fk_sales_leads_tenant',            'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_companies',        'fk_sales_companies_tenant',        'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_meetings',         'fk_sales_meetings_tenant',         'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_quotations',       'fk_sales_quotations_tenant',       'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_contracts',        'fk_sales_contracts_tenant',        'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_onboarding',       'fk_sales_onboarding_tenant',       'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_revenue_forecast', 'fk_sales_revenue_forecast_tenant', 'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('clients',                'fk_clients_tenant',                'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');

DROP PROCEDURE IF EXISTS `__ti_tenantize`;
DROP PROCEDURE IF EXISTS `__ti_add_column`;
DROP PROCEDURE IF EXISTS `__ti_add_key`;
DROP PROCEDURE IF EXISTS `__ti_add_fk`;
