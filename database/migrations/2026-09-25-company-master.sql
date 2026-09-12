-- =============================================================
-- Sales Company (Account) master upgrade (additive, non-destructive)
-- -------------------------------------------------------------
-- Principles:
--   * The company is the CANONICAL account record. Leads, meetings,
--     quotations, contracts, onboarding and contacts all reference it
--     by numeric `company_id`. Legacy free-text `company_name` columns
--     are kept for display / backwards compatibility only.
--   * Company codes are generated race-safely via `record_id_sequences`
--     (prefix MCLD) — never MAX()+1.
--   * Status / owner / priority changes, archive and merge are recorded
--     append-only in the shared `sales_audit_log`. Companies are soft
--     archived (archived_at), never hard-deleted.
--
-- This file documents the target schema for fresh installs. The same
-- objects are also created/altered idempotently at runtime by
-- ensureCompanyMasterSchema() in lib/sales/company-master.ts so existing
-- databases self-heal without a manual migration step.
--
-- This script is SAFE TO RE-RUN. MySQL 8 has no reliable
-- `ADD COLUMN IF NOT EXISTS`, so each column / key / enum change is
-- applied through helper procedures that first check information_schema
-- and skip anything that already exists (mirrors the runtime helpers
-- addColumnIfMissing / addKeyIfMissing).
-- =============================================================

DELIMITER $$

-- Adds a column only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__cm_add_column` $$
CREATE PROCEDURE `__cm_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

-- Adds an index only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__cm_add_key` $$
CREATE PROCEDURE `__cm_add_key`(IN p_table VARCHAR(64), IN p_key VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_key
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- --- sales_companies: new master columns ----------------------------
CALL `__cm_add_column`('sales_companies', 'legal_name',         '`legal_name` VARCHAR(190) DEFAULT NULL AFTER `company_name`');
CALL `__cm_add_column`('sales_companies', 'domain',             '`domain` VARCHAR(150) DEFAULT NULL AFTER `website`');
CALL `__cm_add_column`('sales_companies', 'phone',              '`phone` VARCHAR(40) DEFAULT NULL AFTER `company_email`');
CALL `__cm_add_column`('sales_companies', 'alt_phone',          '`alt_phone` VARCHAR(40) DEFAULT NULL AFTER `phone`');
CALL `__cm_add_column`('sales_companies', 'address_line',       '`address_line` VARCHAR(255) DEFAULT NULL AFTER `alt_phone`');
CALL `__cm_add_column`('sales_companies', 'city',               '`city` VARCHAR(120) DEFAULT NULL AFTER `address_line`');
CALL `__cm_add_column`('sales_companies', 'state',              '`state` VARCHAR(120) DEFAULT NULL AFTER `city`');
CALL `__cm_add_column`('sales_companies', 'postal_code',        '`postal_code` VARCHAR(30) DEFAULT NULL AFTER `state`');
CALL `__cm_add_column`('sales_companies', 'segment',            '`segment` VARCHAR(80) DEFAULT NULL AFTER `company_type`');
CALL `__cm_add_column`('sales_companies', 'annual_revenue',     '`annual_revenue` DECIMAL(16,2) DEFAULT NULL AFTER `employee_count`');
CALL `__cm_add_column`('sales_companies', 'tags',               '`tags` VARCHAR(500) DEFAULT NULL AFTER `segment`');
CALL `__cm_add_column`('sales_companies', 'source',             '`source` VARCHAR(120) DEFAULT NULL AFTER `tags`');
CALL `__cm_add_column`('sales_companies', 'description',        '`description` TEXT DEFAULT NULL AFTER `source`');
CALL `__cm_add_column`('sales_companies', 'account_health',     '`account_health` TINYINT UNSIGNED DEFAULT NULL AFTER `priority`');
CALL `__cm_add_column`('sales_companies', 'first_contact_date', '`first_contact_date` DATE DEFAULT NULL AFTER `last_contact_date`');
CALL `__cm_add_column`('sales_companies', 'last_activity_at',   '`last_activity_at` DATETIME DEFAULT NULL AFTER `first_contact_date`');
CALL `__cm_add_column`('sales_companies', 'archived_at',        '`archived_at` DATETIME DEFAULT NULL AFTER `last_activity_at`');
CALL `__cm_add_column`('sales_companies', 'archived_by',        '`archived_by` INT UNSIGNED DEFAULT NULL AFTER `archived_at`');
CALL `__cm_add_column`('sales_companies', 'merged_into_id',     '`merged_into_id` INT UNSIGNED DEFAULT NULL AFTER `archived_by`');
CALL `__cm_add_column`('sales_companies', 'row_version',        '`row_version` INT UNSIGNED NOT NULL DEFAULT 1 AFTER `merged_into_id`');

-- Widen enums additively (existing values are preserved; MODIFY is naturally idempotent).
ALTER TABLE `sales_companies`
  MODIFY `status` ENUM('New','Contacted','Qualified','Customer','Inactive','Lost') NOT NULL DEFAULT 'New',
  MODIFY `priority` ENUM('Low','Medium','High','Critical') DEFAULT NULL;

CALL `__cm_add_key`('sales_companies', 'idx_companies_priority', 'KEY `idx_companies_priority` (`priority`)');
CALL `__cm_add_key`('sales_companies', 'idx_companies_domain',   'KEY `idx_companies_domain` (`domain`)');
CALL `__cm_add_key`('sales_companies', 'idx_companies_archived', 'KEY `idx_companies_archived` (`archived_at`)');
CALL `__cm_add_key`('sales_companies', 'idx_companies_assigned', 'KEY `idx_companies_assigned` (`assigned_to`)');

-- --- Relational contacts parented to a company ----------------------
CREATE TABLE IF NOT EXISTS `sales_contacts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `company_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `title` VARCHAR(150) DEFAULT NULL,
  `email` VARCHAR(190) DEFAULT NULL,
  `phone` VARCHAR(40) DEFAULT NULL,
  `linkedin_url` VARCHAR(190) DEFAULT NULL,
  `is_primary` TINYINT(1) NOT NULL DEFAULT 0,
  `notes` VARCHAR(500) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_contacts_company` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- company_id linkage on downstream Sales tables ------------------
CALL `__cm_add_column`('sales_meetings',   'company_id', '`company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`');
CALL `__cm_add_column`('sales_quotations', 'company_id', '`company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`');
CALL `__cm_add_column`('sales_contracts',  'company_id', '`company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`');
CALL `__cm_add_column`('sales_onboarding', 'company_id', '`company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`');

CALL `__cm_add_key`('sales_meetings',   'idx_sales_meetings_company_id',   'KEY `idx_sales_meetings_company_id` (`company_id`)');
CALL `__cm_add_key`('sales_quotations', 'idx_sales_quotations_company_id', 'KEY `idx_sales_quotations_company_id` (`company_id`)');
CALL `__cm_add_key`('sales_contracts',  'idx_sales_contracts_company_id',  'KEY `idx_sales_contracts_company_id` (`company_id`)');
CALL `__cm_add_key`('sales_onboarding', 'idx_sales_onboarding_company_id', 'KEY `idx_sales_onboarding_company_id` (`company_id`)');

-- --- Backfill company_id by unambiguous exact name match ------------
-- Only assigns when the name resolves to exactly one company.
UPDATE `sales_leads` t
  JOIN (SELECT company_name, MIN(id) AS cid, COUNT(*) AS n FROM sales_companies
        WHERE archived_at IS NULL AND company_name <> '' GROUP BY company_name) c
    ON c.company_name = t.company_name AND c.n = 1
  SET t.company_id = c.cid
  WHERE t.company_id IS NULL AND t.company_name IS NOT NULL AND t.company_name <> '';

-- --- Clean up helper procedures -------------------------------------
DROP PROCEDURE IF EXISTS `__cm_add_column`;
DROP PROCEDURE IF EXISTS `__cm_add_key`;
