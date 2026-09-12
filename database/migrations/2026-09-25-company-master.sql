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
-- =============================================================

-- --- sales_companies: new master columns ----------------------------
ALTER TABLE `sales_companies`
  ADD COLUMN `legal_name` VARCHAR(190) DEFAULT NULL AFTER `company_name`,
  ADD COLUMN `domain` VARCHAR(150) DEFAULT NULL AFTER `website`,
  ADD COLUMN `phone` VARCHAR(40) DEFAULT NULL AFTER `company_email`,
  ADD COLUMN `alt_phone` VARCHAR(40) DEFAULT NULL AFTER `phone`,
  ADD COLUMN `address_line` VARCHAR(255) DEFAULT NULL AFTER `alt_phone`,
  ADD COLUMN `city` VARCHAR(120) DEFAULT NULL AFTER `address_line`,
  ADD COLUMN `state` VARCHAR(120) DEFAULT NULL AFTER `city`,
  ADD COLUMN `postal_code` VARCHAR(30) DEFAULT NULL AFTER `state`,
  ADD COLUMN `segment` VARCHAR(80) DEFAULT NULL AFTER `company_type`,
  ADD COLUMN `annual_revenue` DECIMAL(16,2) DEFAULT NULL AFTER `employee_count`,
  ADD COLUMN `tags` VARCHAR(500) DEFAULT NULL AFTER `segment`,
  ADD COLUMN `source` VARCHAR(120) DEFAULT NULL AFTER `tags`,
  ADD COLUMN `description` TEXT DEFAULT NULL AFTER `source`,
  ADD COLUMN `account_health` TINYINT UNSIGNED DEFAULT NULL AFTER `priority`,
  ADD COLUMN `first_contact_date` DATE DEFAULT NULL AFTER `last_contact_date`,
  ADD COLUMN `last_activity_at` DATETIME DEFAULT NULL AFTER `first_contact_date`,
  ADD COLUMN `archived_at` DATETIME DEFAULT NULL AFTER `last_activity_at`,
  ADD COLUMN `archived_by` INT UNSIGNED DEFAULT NULL AFTER `archived_at`,
  ADD COLUMN `merged_into_id` INT UNSIGNED DEFAULT NULL AFTER `archived_by`,
  ADD COLUMN `row_version` INT UNSIGNED NOT NULL DEFAULT 1 AFTER `merged_into_id`;

ALTER TABLE `sales_companies`
  MODIFY `status` ENUM('New','Contacted','Qualified','Customer','Inactive','Lost') NOT NULL DEFAULT 'New',
  MODIFY `priority` ENUM('Low','Medium','High','Critical') DEFAULT NULL;

ALTER TABLE `sales_companies` ADD KEY `idx_companies_priority` (`priority`);
ALTER TABLE `sales_companies` ADD KEY `idx_companies_domain` (`domain`);
ALTER TABLE `sales_companies` ADD KEY `idx_companies_archived` (`archived_at`);
ALTER TABLE `sales_companies` ADD KEY `idx_companies_assigned` (`assigned_to`);

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
ALTER TABLE `sales_meetings`   ADD COLUMN `company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`;
ALTER TABLE `sales_quotations` ADD COLUMN `company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`;
ALTER TABLE `sales_contracts`  ADD COLUMN `company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`;
ALTER TABLE `sales_onboarding` ADD COLUMN `company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`;

ALTER TABLE `sales_meetings`   ADD KEY `idx_sales_meetings_company_id` (`company_id`);
ALTER TABLE `sales_quotations` ADD KEY `idx_sales_quotations_company_id` (`company_id`);
ALTER TABLE `sales_contracts`  ADD KEY `idx_sales_contracts_company_id` (`company_id`);
ALTER TABLE `sales_onboarding` ADD KEY `idx_sales_onboarding_company_id` (`company_id`);

-- --- Backfill company_id by unambiguous exact name match ------------
-- Only assigns when the name resolves to exactly one company.
UPDATE `sales_leads` t
  JOIN (SELECT company_name, MIN(id) AS cid, COUNT(*) AS n FROM sales_companies
        WHERE archived_at IS NULL AND company_name <> '' GROUP BY company_name) c
    ON c.company_name = t.company_name AND c.n = 1
  SET t.company_id = c.cid
  WHERE t.company_id IS NULL AND t.company_name IS NOT NULL AND t.company_name <> '';
