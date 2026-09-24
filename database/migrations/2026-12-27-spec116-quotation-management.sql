-- =============================================================================
-- SPEC 116 — QUOTATION MANAGEMENT
-- =============================================================================
-- Full commercial quoting system for the Sales CRM. A quotation is a header row
-- (sales_quotations) with an ordered set of line items (sales_quotation_items),
-- GST-aware pricing/discount/tax totals, terms & validity, an approval +
-- acceptance/rejection lifecycle, versioning (revisions keep the same MQ-xxx
-- code with an incremented version), and conversion links to a contract /
-- invoice. Every state change is recorded in sales_quotation_events.
--
-- This file mirrors the runtime self-heal in `ensureQuotationSchema()`
-- (lib/sales/quotation-service.ts) and consolidates the earlier upgrade in
-- 2026-09-26-upgrade-sales-quotations.sql. Keep all three in sync. PDF/email
-- generation and calculation live in lib/sales/quotation-pdf.ts and
-- lib/sales/quotation-calc.ts; no extra tables are needed for those.
--
-- Conventions:
--   * InnoDB / utf8mb4.
--   * Idempotent: guarded column/index helpers + CREATE TABLE IF NOT EXISTS,
--     safe to re-run even after the runtime self-healer has applied some of it.
--   * Requires MySQL 5.7+ / MariaDB 10.x. Run as a single script; DELIMITER
--     handling is needed for the helper procedures below.
-- =============================================================================

DELIMITER $$

-- --- Idempotent helper procedures ----------------------------------------
DROP PROCEDURE IF EXISTS `mnt_q_add_column`$$
CREATE PROCEDURE `mnt_q_add_column`(IN in_table VARCHAR(64), IN in_column VARCHAR(64), IN in_definition TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = in_table AND column_name = in_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', in_table, '` ADD COLUMN `', in_column, '` ', in_definition);
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS `mnt_q_add_index`$$
CREATE PROCEDURE `mnt_q_add_index`(IN in_table VARCHAR(64), IN in_index VARCHAR(64), IN in_columns TEXT, IN in_unique TINYINT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = in_table AND index_name = in_index
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', in_table, '` ADD ', IF(in_unique = 1, 'UNIQUE ', ''), 'INDEX `', in_index, '` (', in_columns, ')');
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS `mnt_q_drop_index`$$
CREATE PROCEDURE `mnt_q_drop_index`(IN in_table VARCHAR(64), IN in_index VARCHAR(64))
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

-- -----------------------------------------------------------------------------
-- Header base table — created if a fresh install has no legacy sales_quotations
-- yet. The guarded ALTERs below then bring any pre-existing table up to shape.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_quotations` (
  `id`           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `quote_code`   VARCHAR(30)   NOT NULL,
  `quote_date`   DATE          DEFAULT NULL,
  `company_name` VARCHAR(200)  DEFAULT NULL,
  `contact_person` VARCHAR(150) DEFAULT NULL,
  `opportunity_name` VARCHAR(200) DEFAULT NULL,
  `valid_until`  DATE          DEFAULT NULL,
  `status`       ENUM('Draft','Sent','Accepted','Rejected','Expired','Cancelled') NOT NULL DEFAULT 'Draft',
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `added_by`     INT UNSIGNED  DEFAULT NULL,
  `created_at`   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Header: relational + snapshot columns -------------------------------
CALL `mnt_q_add_column`('sales_quotations', 'company_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'contact_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'lead_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'meeting_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'owner_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'contact_email', "VARCHAR(190) DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'contact_phone', "VARCHAR(60) DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'contact_designation', "VARCHAR(120) DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'reference', "VARCHAR(190) DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'source_type', "VARCHAR(20) DEFAULT 'Manual'");
CALL `mnt_q_add_column`('sales_quotations', 'source_module', "VARCHAR(40) DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'source_record_id', "VARCHAR(64) DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'bill_to_address', "TEXT DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'ship_to_address', "TEXT DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'place_of_supply', "VARCHAR(80) DEFAULT NULL");

-- --- Header: financial columns -------------------------------------------
CALL `mnt_q_add_column`('sales_quotations', 'currency', "VARCHAR(8) NOT NULL DEFAULT 'INR'");
CALL `mnt_q_add_column`('sales_quotations', 'exchange_rate', "DECIMAL(14,6) NOT NULL DEFAULT 1");
CALL `mnt_q_add_column`('sales_quotations', 'tax_mode', "ENUM('Exclusive','Inclusive') NOT NULL DEFAULT 'Exclusive'");
CALL `mnt_q_add_column`('sales_quotations', 'gst_treatment', "ENUM('Intra','Inter','None') NOT NULL DEFAULT 'Intra'");
CALL `mnt_q_add_column`('sales_quotations', 'subtotal', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_q_add_column`('sales_quotations', 'discount_type', "ENUM('none','percent','fixed') NOT NULL DEFAULT 'none'");
CALL `mnt_q_add_column`('sales_quotations', 'discount_value', "DECIMAL(14,4) NOT NULL DEFAULT 0");
CALL `mnt_q_add_column`('sales_quotations', 'discount_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_q_add_column`('sales_quotations', 'taxable_value', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_q_add_column`('sales_quotations', 'cgst_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_q_add_column`('sales_quotations', 'sgst_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_q_add_column`('sales_quotations', 'igst_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_q_add_column`('sales_quotations', 'tax_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_q_add_column`('sales_quotations', 'round_off', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_q_add_column`('sales_quotations', 'grand_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");

-- --- Header: terms + notes ------------------------------------------------
CALL `mnt_q_add_column`('sales_quotations', 'payment_terms', "VARCHAR(120) DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'delivery_terms', "VARCHAR(255) DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'terms_text', "TEXT DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'customer_notes', "TEXT DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'internal_notes', "TEXT DEFAULT NULL");

-- --- Header: versioning + lifecycle --------------------------------------
CALL `mnt_q_add_column`('sales_quotations', 'version', "INT UNSIGNED NOT NULL DEFAULT 1");
CALL `mnt_q_add_column`('sales_quotations', 'root_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'superseded_by', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'is_current', "TINYINT(1) NOT NULL DEFAULT 1");
CALL `mnt_q_add_column`('sales_quotations', 'row_version', "INT UNSIGNED NOT NULL DEFAULT 1");
CALL `mnt_q_add_column`('sales_quotations', 'sent_at', "DATETIME DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'viewed_at', "DATETIME DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'accepted_at', "DATETIME DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'accepted_by', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'rejected_at', "DATETIME DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'rejected_by', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'rejection_reason', "VARCHAR(120) DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'rejection_notes', "TEXT DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'converted_contract_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'converted_invoice_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'cancelled_at', "DATETIME DEFAULT NULL");
CALL `mnt_q_add_column`('sales_quotations', 'archived_at', "DATETIME DEFAULT NULL");

-- Widen the status enum to include Cancelled (safe to re-run).
ALTER TABLE `sales_quotations`
  MODIFY COLUMN `status` ENUM('Draft','Sent','Accepted','Rejected','Expired','Cancelled') NOT NULL DEFAULT 'Draft';

-- The customer-facing quote code is unique per version, not globally, so a
-- revision keeps the same MQ-xxx number with an incremented version.
CALL `mnt_q_drop_index`('sales_quotations', 'uniq_quote_code');
CALL `mnt_q_add_index`('sales_quotations', 'uniq_quote_code_version', '`quote_code`, `version`', 1);
CALL `mnt_q_add_index`('sales_quotations', 'idx_quotations_company', '`company_id`', 0);
CALL `mnt_q_add_index`('sales_quotations', 'idx_quotations_lead', '`lead_id`', 0);
CALL `mnt_q_add_index`('sales_quotations', 'idx_quotations_status', '`status`', 0);
CALL `mnt_q_add_index`('sales_quotations', 'idx_quotations_root', '`root_id`', 0);

-- Backfill root_id for legacy rows (each is its own root).
UPDATE `sales_quotations` SET `root_id` = `id` WHERE `root_id` IS NULL;
-- Seed the new financial columns from the legacy single total.
UPDATE `sales_quotations`
   SET `grand_total` = `total_amount`,
       `subtotal` = `total_amount`,
       `taxable_value` = `total_amount`
 WHERE `grand_total` = 0 AND `total_amount` <> 0;

-- -----------------------------------------------------------------------------
-- Line items — one row per quotation line, with per-line discount + GST split.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- Lifecycle audit trail — created / sent / viewed / accepted / rejected /
-- revised / converted events, with optional JSON meta.
-- -----------------------------------------------------------------------------
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

-- --- Downstream links back to the source quotation (conversion to order) --
CALL `mnt_q_add_column`('sales_contracts', 'source_quotation_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_q_add_column`('sales_invoices', 'source_quotation_id', "INT UNSIGNED DEFAULT NULL");

-- --- Clean up helper procedures ------------------------------------------
DROP PROCEDURE IF EXISTS `mnt_q_add_column`;
DROP PROCEDURE IF EXISTS `mnt_q_add_index`;
DROP PROCEDURE IF EXISTS `mnt_q_drop_index`;
