-- =====================================================================
-- Upgrade Sales Quotations into a full commercial quoting system.
--
-- Adds relational links (company / contact / lead / meeting), a proper
-- line-item table, GST-aware financial columns, versioning/revision
-- tracking and a lifecycle audit trail. Mirrors lib/sales/quotation-service.ts
-- `ensureQuotationSchema()`, which applies the same changes idempotently at
-- runtime so installs that never run this file still upgrade cleanly.
-- =====================================================================

-- --- Header: relational + snapshot columns -------------------------------
ALTER TABLE `sales_quotations`
  ADD COLUMN `company_id` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN `contact_id` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN `lead_id` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN `meeting_id` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN `owner_id` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN `contact_email` VARCHAR(190) DEFAULT NULL,
  ADD COLUMN `contact_phone` VARCHAR(60) DEFAULT NULL,
  ADD COLUMN `contact_designation` VARCHAR(120) DEFAULT NULL,
  ADD COLUMN `reference` VARCHAR(190) DEFAULT NULL,
  ADD COLUMN `source_type` VARCHAR(20) DEFAULT 'Manual',
  ADD COLUMN `source_module` VARCHAR(40) DEFAULT NULL,
  ADD COLUMN `source_record_id` VARCHAR(64) DEFAULT NULL,
  ADD COLUMN `bill_to_address` TEXT DEFAULT NULL,
  ADD COLUMN `ship_to_address` TEXT DEFAULT NULL,
  ADD COLUMN `place_of_supply` VARCHAR(80) DEFAULT NULL;

-- --- Header: financial columns -------------------------------------------
ALTER TABLE `sales_quotations`
  ADD COLUMN `currency` VARCHAR(8) NOT NULL DEFAULT 'INR',
  ADD COLUMN `exchange_rate` DECIMAL(14,6) NOT NULL DEFAULT 1,
  ADD COLUMN `tax_mode` ENUM('Exclusive','Inclusive') NOT NULL DEFAULT 'Exclusive',
  ADD COLUMN `gst_treatment` ENUM('Intra','Inter','None') NOT NULL DEFAULT 'Intra',
  ADD COLUMN `subtotal` DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN `discount_type` ENUM('none','percent','fixed') NOT NULL DEFAULT 'none',
  ADD COLUMN `discount_value` DECIMAL(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN `discount_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN `taxable_value` DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN `cgst_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN `sgst_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN `igst_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN `tax_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN `round_off` DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN `grand_total` DECIMAL(14,2) NOT NULL DEFAULT 0;

-- --- Header: terms + notes ------------------------------------------------
ALTER TABLE `sales_quotations`
  ADD COLUMN `payment_terms` VARCHAR(120) DEFAULT NULL,
  ADD COLUMN `delivery_terms` VARCHAR(255) DEFAULT NULL,
  ADD COLUMN `terms_text` TEXT DEFAULT NULL,
  ADD COLUMN `customer_notes` TEXT DEFAULT NULL,
  ADD COLUMN `internal_notes` TEXT DEFAULT NULL;

-- --- Header: versioning + lifecycle --------------------------------------
ALTER TABLE `sales_quotations`
  ADD COLUMN `version` INT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN `root_id` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN `superseded_by` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN `is_current` TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN `row_version` INT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN `sent_at` DATETIME DEFAULT NULL,
  ADD COLUMN `viewed_at` DATETIME DEFAULT NULL,
  ADD COLUMN `accepted_at` DATETIME DEFAULT NULL,
  ADD COLUMN `accepted_by` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN `rejected_at` DATETIME DEFAULT NULL,
  ADD COLUMN `rejected_by` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN `rejection_reason` VARCHAR(120) DEFAULT NULL,
  ADD COLUMN `rejection_notes` TEXT DEFAULT NULL,
  ADD COLUMN `converted_contract_id` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN `converted_invoice_id` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN `cancelled_at` DATETIME DEFAULT NULL,
  ADD COLUMN `archived_at` DATETIME DEFAULT NULL;

-- Widen the status enum to include Cancelled.
ALTER TABLE `sales_quotations`
  MODIFY COLUMN `status` ENUM('Draft','Sent','Accepted','Rejected','Expired','Cancelled') NOT NULL DEFAULT 'Draft';

-- The customer-facing quote code is now unique per version, not globally,
-- so a revision keeps the same MQ-xxx number with an incremented version.
ALTER TABLE `sales_quotations` DROP INDEX `uniq_quote_code`;
ALTER TABLE `sales_quotations` ADD UNIQUE KEY `uniq_quote_code_version` (`quote_code`, `version`);
ALTER TABLE `sales_quotations` ADD KEY `idx_quotations_company` (`company_id`);
ALTER TABLE `sales_quotations` ADD KEY `idx_quotations_lead` (`lead_id`);
ALTER TABLE `sales_quotations` ADD KEY `idx_quotations_status` (`status`);
ALTER TABLE `sales_quotations` ADD KEY `idx_quotations_root` (`root_id`);

-- Backfill root_id for legacy rows (each is its own root).
UPDATE `sales_quotations` SET `root_id` = `id` WHERE `root_id` IS NULL;
-- Seed the new financial columns from the legacy single total.
UPDATE `sales_quotations`
   SET `grand_total` = `total_amount`,
       `subtotal` = `total_amount`,
       `taxable_value` = `total_amount`
 WHERE `grand_total` = 0 AND `total_amount` <> 0;

-- --- Line items -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_quotation_items` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `quotation_id` INT UNSIGNED NOT NULL,
  `line_no` INT UNSIGNED NOT NULL DEFAULT 1,
  `item_type` VARCHAR(30) NOT NULL DEFAULT 'Service',
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `hsn_sac` VARCHAR(20) DEFAULT NULL,
  `quantity` DECIMAL(14,3) NOT NULL DEFAULT 1,
  `unit` VARCHAR(30) DEFAULT NULL,
  `rate` DECIMAL(14,4) NOT NULL DEFAULT 0,
  `discount_type` ENUM('none','percent','fixed') NOT NULL DEFAULT 'none',
  `discount_value` DECIMAL(14,4) NOT NULL DEFAULT 0,
  `discount_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `tax_rate` DECIMAL(6,3) NOT NULL DEFAULT 0,
  `taxable_value` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `cgst` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `sgst` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `igst` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `tax_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `line_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_quotation_items_quote` (`quotation_id`),
  CONSTRAINT `fk_quotation_items_quote` FOREIGN KEY (`quotation_id`)
    REFERENCES `sales_quotations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Lifecycle audit trail ------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_quotation_events` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `quotation_id` INT UNSIGNED NOT NULL,
  `event_type` VARCHAR(40) NOT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  `meta` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_quotation_events_quote` (`quotation_id`),
  CONSTRAINT `fk_quotation_events_quote` FOREIGN KEY (`quotation_id`)
    REFERENCES `sales_quotations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Downstream links back to the source quotation ------------------------
ALTER TABLE `sales_contracts` ADD COLUMN `source_quotation_id` INT UNSIGNED DEFAULT NULL;
ALTER TABLE `sales_invoices` ADD COLUMN `source_quotation_id` INT UNSIGNED DEFAULT NULL;
