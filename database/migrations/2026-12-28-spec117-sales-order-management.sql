-- =============================================================================
-- SPEC 117 — SALES ORDER MANAGEMENT
-- =============================================================================
-- Confirmed sales orders for the Sales CRM. A sales order is a header row
-- (sales_orders) with an ordered set of line items (sales_order_items), the
-- same GST-aware pricing/discount/tax totals used by quotations, plus delivery
-- and billing addresses, an order lifecycle (Draft -> Confirmed -> Partially
-- Fulfilled -> Fulfilled -> Closed / Cancelled) with an approval gate, partial
-- fulfilment tracking per line, and links back to the source quotation and
-- forward to the invoices raised against the order. Every state change is
-- recorded in sales_order_events.
--
-- Lifecycle logic is expected to live in lib/sales/order-service.ts and route
-- all state changes through it (mirroring deal-pipeline / quotation-service).
-- This file is the explicit, versioned schema artifact for the spec and should
-- stay in sync with that service's self-heal routine once it exists.
--
-- Finance / inventory integration:
--   * Conversion from a quotation copies header + lines and back-links via
--     source_quotation_id.
--   * Invoicing links each raised invoice back to the order via
--     sales_invoices.source_order_id (added below), and the order tracks
--     invoiced / fulfilled quantities so partial invoicing/fulfilment is
--     represented without a separate ledger table.
--
-- Conventions:
--   * InnoDB / utf8mb4.
--   * Idempotent: guarded column/index helpers + CREATE TABLE IF NOT EXISTS,
--     safe to re-run.
--   * Child rows cascade-delete with their parent order.
--   * Requires MySQL 5.7+ / MariaDB 10.x. Run as a single script; DELIMITER
--     handling is needed for the helper procedures below.
-- =============================================================================

DELIMITER $$

-- --- Idempotent helper procedures ----------------------------------------
DROP PROCEDURE IF EXISTS `mnt_so_add_column`$$
CREATE PROCEDURE `mnt_so_add_column`(IN in_table VARCHAR(64), IN in_column VARCHAR(64), IN in_definition TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = in_table AND column_name = in_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', in_table, '` ADD COLUMN `', in_column, '` ', in_definition);
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS `mnt_so_add_index`$$
CREATE PROCEDURE `mnt_so_add_index`(IN in_table VARCHAR(64), IN in_index VARCHAR(64), IN in_columns TEXT, IN in_unique TINYINT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = in_table AND index_name = in_index
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', in_table, '` ADD ', IF(in_unique = 1, 'UNIQUE ', ''), 'INDEX `', in_index, '` (', in_columns, ')');
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

-- -----------------------------------------------------------------------------
-- Order header — one row per sales order. Carries customer + address snapshot,
-- GST-aware financial totals, lifecycle + approval state, fulfilment / invoice
-- rollups and conversion links.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_orders` (
  `id`                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `order_code`          VARCHAR(30)   NOT NULL,
  `order_date`          DATE          DEFAULT NULL,

  -- Customer / relational + snapshot columns
  `company_id`          INT UNSIGNED  DEFAULT NULL,
  `company_name`        VARCHAR(200)  DEFAULT NULL,
  `contact_id`          INT UNSIGNED  DEFAULT NULL,
  `contact_person`      VARCHAR(150)  DEFAULT NULL,
  `contact_email`       VARCHAR(190)  DEFAULT NULL,
  `contact_phone`       VARCHAR(60)   DEFAULT NULL,
  `owner_id`            INT UNSIGNED  DEFAULT NULL,
  `team_id`             INT UNSIGNED  DEFAULT NULL,
  `reference`           VARCHAR(190)  DEFAULT NULL,
  `customer_po_number`  VARCHAR(120)  DEFAULT NULL,
  `customer_po_date`    DATE          DEFAULT NULL,

  -- Addresses + place of supply
  `bill_to_address`     TEXT          DEFAULT NULL,
  `ship_to_address`     TEXT          DEFAULT NULL,
  `place_of_supply`     VARCHAR(80)   DEFAULT NULL,

  -- Delivery
  `delivery_method`     VARCHAR(120)  DEFAULT NULL,
  `delivery_terms`      VARCHAR(255)  DEFAULT NULL,
  `expected_delivery_date` DATE       DEFAULT NULL,
  `delivered_at`        DATETIME      DEFAULT NULL,

  -- Financials (mirrors sales_quotations)
  `currency`            VARCHAR(8)    NOT NULL DEFAULT 'INR',
  `exchange_rate`       DECIMAL(14,6) NOT NULL DEFAULT 1,
  `tax_mode`            ENUM('Exclusive','Inclusive') NOT NULL DEFAULT 'Exclusive',
  `gst_treatment`       ENUM('Intra','Inter','None')  NOT NULL DEFAULT 'Intra',
  `subtotal`            DECIMAL(14,2) NOT NULL DEFAULT 0,
  `discount_type`       ENUM('none','percent','fixed') NOT NULL DEFAULT 'none',
  `discount_value`      DECIMAL(14,4) NOT NULL DEFAULT 0,
  `discount_total`      DECIMAL(14,2) NOT NULL DEFAULT 0,
  `taxable_value`       DECIMAL(14,2) NOT NULL DEFAULT 0,
  `cgst_total`          DECIMAL(14,2) NOT NULL DEFAULT 0,
  `sgst_total`          DECIMAL(14,2) NOT NULL DEFAULT 0,
  `igst_total`          DECIMAL(14,2) NOT NULL DEFAULT 0,
  `tax_total`           DECIMAL(14,2) NOT NULL DEFAULT 0,
  `round_off`           DECIMAL(14,2) NOT NULL DEFAULT 0,
  `grand_total`         DECIMAL(14,2) NOT NULL DEFAULT 0,

  -- Terms + notes
  `payment_terms`       VARCHAR(120)  DEFAULT NULL,
  `terms_text`          TEXT          DEFAULT NULL,
  `customer_notes`      TEXT          DEFAULT NULL,
  `internal_notes`      TEXT          DEFAULT NULL,

  -- Lifecycle + approval
  `status`              ENUM('Draft','Confirmed','Partially Fulfilled','Fulfilled','Closed','Cancelled') NOT NULL DEFAULT 'Draft',
  `approval_status`     ENUM('None','Pending','Approved','Rejected') NOT NULL DEFAULT 'None',
  `approval_note`       VARCHAR(500)  DEFAULT NULL,
  `approved_by`         INT UNSIGNED  DEFAULT NULL,
  `approval_requested_at` DATETIME    DEFAULT NULL,
  `approval_decided_at` DATETIME      DEFAULT NULL,
  `confirmed_at`        DATETIME      DEFAULT NULL,
  `cancelled_at`        DATETIME      DEFAULT NULL,
  `cancel_reason`       VARCHAR(120)  DEFAULT NULL,

  -- Fulfilment + invoicing rollups (kept in sync from line items)
  `fulfillment_status` ENUM('Pending','Partial','Fulfilled') NOT NULL DEFAULT 'Pending',
  `invoice_status`     ENUM('Uninvoiced','Partial','Invoiced') NOT NULL DEFAULT 'Uninvoiced',
  `invoiced_amount`    DECIMAL(14,2) NOT NULL DEFAULT 0,

  -- Conversion source
  `source_quotation_id` INT UNSIGNED DEFAULT NULL,

  -- Bookkeeping
  `row_version`        INT UNSIGNED  NOT NULL DEFAULT 1,
  `archived_at`        DATETIME      DEFAULT NULL,
  `created_by`         INT UNSIGNED  DEFAULT NULL,
  `created_at`         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_order_code` (`order_code`),
  KEY `idx_orders_company` (`company_id`),
  KEY `idx_orders_owner` (`owner_id`, `status`),
  KEY `idx_orders_status` (`status`, `archived_at`),
  KEY `idx_orders_quotation` (`source_quotation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Line items — one row per order line, with per-line discount + GST split and
-- ordered / fulfilled / invoiced quantities for partial fulfilment tracking.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_order_items` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`       INT UNSIGNED NOT NULL,
  `line_no`        INT UNSIGNED NOT NULL DEFAULT 1,
  `item_type`      VARCHAR(30)  NOT NULL DEFAULT 'Service',
  `name`           VARCHAR(255) NOT NULL,
  `description`    TEXT         DEFAULT NULL,
  `hsn_sac`        VARCHAR(20)  DEFAULT NULL,
  `quantity`       DECIMAL(14,3) NOT NULL DEFAULT 1,
  `unit`           VARCHAR(30)  DEFAULT NULL,
  `rate`           DECIMAL(14,4) NOT NULL DEFAULT 0,
  `discount_type`  ENUM('none','percent','fixed') NOT NULL DEFAULT 'none',
  `discount_value` DECIMAL(14,4) NOT NULL DEFAULT 0,
  `discount_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `tax_rate`       DECIMAL(6,3) NOT NULL DEFAULT 0,
  `taxable_value`  DECIMAL(14,2) NOT NULL DEFAULT 0,
  `cgst`           DECIMAL(14,2) NOT NULL DEFAULT 0,
  `sgst`           DECIMAL(14,2) NOT NULL DEFAULT 0,
  `igst`           DECIMAL(14,2) NOT NULL DEFAULT 0,
  `tax_amount`     DECIMAL(14,2) NOT NULL DEFAULT 0,
  `line_total`     DECIMAL(14,2) NOT NULL DEFAULT 0,
  -- Partial fulfilment / invoicing per line
  `fulfilled_qty`  DECIMAL(14,3) NOT NULL DEFAULT 0,
  `invoiced_qty`   DECIMAL(14,3) NOT NULL DEFAULT 0,
  `created_at`     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_order_items_order` (`order_id`),
  CONSTRAINT `fk_order_items_order` FOREIGN KEY (`order_id`)
    REFERENCES `sales_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Fulfilment records — one row per (partial) shipment/delivery against an order,
-- so multiple partial fulfilments are auditable rather than only a rollup.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_order_fulfillments` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`      INT UNSIGNED NOT NULL,
  `fulfilled_at`  DATETIME     DEFAULT NULL,
  `reference`     VARCHAR(120) DEFAULT NULL,
  `carrier`       VARCHAR(120) DEFAULT NULL,
  `tracking_no`   VARCHAR(120) DEFAULT NULL,
  `notes`         TEXT         DEFAULT NULL,
  `lines`         JSON         DEFAULT NULL,
  `created_by`    INT UNSIGNED DEFAULT NULL,
  `created_at`    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_order_fulfillments_order` (`order_id`),
  CONSTRAINT `fk_order_fulfillments_order` FOREIGN KEY (`order_id`)
    REFERENCES `sales_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Lifecycle audit trail — created / confirmed / approved / fulfilled /
-- invoiced / cancelled events, with optional JSON meta.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_order_events` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`    INT UNSIGNED NOT NULL,
  `event_type`  VARCHAR(40)  NOT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  `meta`        JSON         DEFAULT NULL,
  `actor_id`    INT UNSIGNED DEFAULT NULL,
  `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_order_events_order` (`order_id`),
  CONSTRAINT `fk_order_events_order` FOREIGN KEY (`order_id`)
    REFERENCES `sales_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Downstream / upstream conversion links ------------------------------
-- Invoices raised against an order link back to it; quotations record which
-- order they were converted into.
CALL `mnt_so_add_column`('sales_invoices', 'source_order_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_so_add_index`('sales_invoices', 'idx_si_source_order', '`source_order_id`', 0);
CALL `mnt_so_add_column`('sales_quotations', 'converted_order_id', "INT UNSIGNED DEFAULT NULL");

-- -----------------------------------------------------------------------------
-- Seed the SO record-id prefix (mirrors 2026-09-01-add-automatic-record-ids.sql).
-- Idempotent: keeps existing counter if the prefix already exists.
-- -----------------------------------------------------------------------------
INSERT INTO record_id_sequences (prefix, next_number) VALUES ('SO', 0)
ON DUPLICATE KEY UPDATE prefix = VALUES(prefix);

-- --- Clean up helper procedures ------------------------------------------
DROP PROCEDURE IF EXISTS `mnt_so_add_column`;
DROP PROCEDURE IF EXISTS `mnt_so_add_index`;
