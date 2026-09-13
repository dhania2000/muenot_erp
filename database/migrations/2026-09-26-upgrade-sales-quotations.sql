-- =====================================================================
-- Upgrade Sales Quotations into a full commercial quoting system.
--
-- Adds relational links (company / contact / lead / meeting), a proper
-- line-item table, GST-aware financial columns, versioning/revision
-- tracking and a lifecycle audit trail. Mirrors lib/sales/quotation-service.ts
-- `ensureQuotationSchema()`, which applies the same changes idempotently at
-- runtime so installs that never run this file still upgrade cleanly.
--
-- This script is fully idempotent: every column / index change is guarded
-- against information_schema, so it is safe to re-run even after the runtime
-- self-healer (or a previous partial run) has already applied some of it.
-- Requires MySQL 5.7+ / MariaDB 10.x. Run as a single script; DELIMITER
-- handling is needed for the helper procedures below.
-- =====================================================================

DELIMITER $$

-- --- Idempotent helper procedures ----------------------------------------
DROP PROCEDURE IF EXISTS `mnt_add_column`$$
CREATE PROCEDURE `mnt_add_column`(IN in_table VARCHAR(64), IN in_column VARCHAR(64), IN in_definition TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = in_table AND column_name = in_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', in_table, '` ADD COLUMN `', in_column, '` ', in_definition);
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS `mnt_add_index`$$
CREATE PROCEDURE `mnt_add_index`(IN in_table VARCHAR(64), IN in_index VARCHAR(64), IN in_columns TEXT, IN in_unique TINYINT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = in_table AND index_name = in_index
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', in_table, '` ADD ', IF(in_unique = 1, 'UNIQUE ', ''), 'INDEX `', in_index, '` (', in_columns, ')');
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS `mnt_drop_index`$$
CREATE PROCEDURE `mnt_drop_index`(IN in_table VARCHAR(64), IN in_index VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = in_table AND index_name = in_index
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', in_table, '` DROP INDEX `', in_index, '`');
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

-- --- Header: relational + snapshot columns -------------------------------
CALL `mnt_add_column`('sales_quotations', 'company_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'contact_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'lead_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'meeting_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'owner_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'contact_email', "VARCHAR(190) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'contact_phone', "VARCHAR(60) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'contact_designation', "VARCHAR(120) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'reference', "VARCHAR(190) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'source_type', "VARCHAR(20) DEFAULT 'Manual'");
CALL `mnt_add_column`('sales_quotations', 'source_module', "VARCHAR(40) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'source_record_id', "VARCHAR(64) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'bill_to_address', "TEXT DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'ship_to_address', "TEXT DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'place_of_supply', "VARCHAR(80) DEFAULT NULL");

-- --- Header: financial columns -------------------------------------------
CALL `mnt_add_column`('sales_quotations', 'currency', "VARCHAR(8) NOT NULL DEFAULT 'INR'");
CALL `mnt_add_column`('sales_quotations', 'exchange_rate', "DECIMAL(14,6) NOT NULL DEFAULT 1");
CALL `mnt_add_column`('sales_quotations', 'tax_mode', "ENUM('Exclusive','Inclusive') NOT NULL DEFAULT 'Exclusive'");
CALL `mnt_add_column`('sales_quotations', 'gst_treatment', "ENUM('Intra','Inter','None') NOT NULL DEFAULT 'Intra'");
CALL `mnt_add_column`('sales_quotations', 'subtotal', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'discount_type', "ENUM('none','percent','fixed') NOT NULL DEFAULT 'none'");
CALL `mnt_add_column`('sales_quotations', 'discount_value', "DECIMAL(14,4) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'discount_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'taxable_value', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'cgst_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'sgst_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'igst_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'tax_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'round_off', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'grand_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");

-- --- Header: terms + notes ------------------------------------------------
CALL `mnt_add_column`('sales_quotations', 'payment_terms', "VARCHAR(120) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'delivery_terms', "VARCHAR(255) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'terms_text', "TEXT DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'customer_notes', "TEXT DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'internal_notes', "TEXT DEFAULT NULL");

-- --- Header: versioning + lifecycle --------------------------------------
CALL `mnt_add_column`('sales_quotations', 'version', "INT UNSIGNED NOT NULL DEFAULT 1");
CALL `mnt_add_column`('sales_quotations', 'root_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'superseded_by', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'is_current', "TINYINT(1) NOT NULL DEFAULT 1");
CALL `mnt_add_column`('sales_quotations', 'row_version', "INT UNSIGNED NOT NULL DEFAULT 1");
CALL `mnt_add_column`('sales_quotations', 'sent_at', "DATETIME DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'viewed_at', "DATETIME DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'accepted_at', "DATETIME DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'accepted_by', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'rejected_at', "DATETIME DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'rejected_by', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'rejection_reason', "VARCHAR(120) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'rejection_notes', "TEXT DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'converted_contract_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'converted_invoice_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'cancelled_at', "DATETIME DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'archived_at', "DATETIME DEFAULT NULL");

-- Widen the status enum to include Cancelled (safe to re-run).
ALTER TABLE `sales_quotations`
  MODIFY COLUMN `status` ENUM('Draft','Sent','Accepted','Rejected','Expired','Cancelled') NOT NULL DEFAULT 'Draft';

-- The customer-facing quote code is now unique per version, not globally,
-- so a revision keeps the same MQ-xxx number with an incremented version.
CALL `mnt_drop_index`('sales_quotations', 'uniq_quote_code');
CALL `mnt_add_index`('sales_quotations', 'uniq_quote_code_version', '`quote_code`, `version`', 1);
CALL `mnt_add_index`('sales_quotations', 'idx_quotations_company', '`company_id`', 0);
CALL `mnt_add_index`('sales_quotations', 'idx_quotations_lead', '`lead_id`', 0);
CALL `mnt_add_index`('sales_quotations', 'idx_quotations_status', '`status`', 0);
CALL `mnt_add_index`('sales_quotations', 'idx_quotations_root', '`root_id`', 0);

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
CALL `mnt_add_column`('sales_contracts', 'source_quotation_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_invoices', 'source_quotation_id', "INT UNSIGNED DEFAULT NULL");

-- --- Clean up helper procedures ------------------------------------------
DROP PROCEDURE IF EXISTS `mnt_add_column`;
DROP PROCEDURE IF EXISTS `mnt_add_index`;
DROP PROCEDURE IF EXISTS `mnt_drop_index`;
