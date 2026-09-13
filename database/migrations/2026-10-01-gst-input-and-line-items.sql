-- =============================================================
-- Purchase Bill line items + GST Input (ITC) subsystem  (Phases 6–20)
-- -------------------------------------------------------------
-- Phase 6/7   purchase_bill_items — multi line items per bill with HSN/SAC,
--             per-line discount and GST split.
-- Phase 10    finance_tax_rates gains effective-dating (effective_from /
--             effective_to / status) so a rate is resolved as-of the bill date.
-- Phase 11-18 finance_gst_input — one Input-GST / ITC record per source bill,
--             carrying the tax split, the ITC ledger (gross / eligible /
--             ineligible / reversal / net), the claim + reconciliation state.
-- Phase 17/18 finance_gstr2b — staging for the auto-drafted GSTR-2B lines the
--             purchase register is reconciled against.
--
-- The same objects are created idempotently at runtime by ensureGstInputSchema()
-- in lib/finance-ensure.ts, so existing databases self-heal without this file.
-- SAFE TO RE-RUN — every statement is guarded (CREATE ... IF NOT EXISTS or an
-- information_schema check).
-- =============================================================

-- ---- Phase 6/7: purchase bill line items ----------------------------------
CREATE TABLE IF NOT EXISTS purchase_bill_items (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  bill_id           VARCHAR(30) NOT NULL,
  line_no           INT NOT NULL DEFAULT 1,
  description       VARCHAR(500) DEFAULT NULL,
  hsn_sac           VARCHAR(20) DEFAULT NULL,
  quantity          DECIMAL(14,3) NOT NULL DEFAULT 0,
  unit              VARCHAR(20) DEFAULT NULL,
  rate              DECIMAL(14,4) NOT NULL DEFAULT 0,
  discount_type     VARCHAR(10) NOT NULL DEFAULT 'amount',
  discount_value    DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_amount   DECIMAL(14,2) NOT NULL DEFAULT 0,
  taxable_value     DECIMAL(14,2) NOT NULL DEFAULT 0,
  gst_rate          DECIMAL(6,2) NOT NULL DEFAULT 0,
  cgst_percent      DECIMAL(6,2) NOT NULL DEFAULT 0,
  cgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst_percent      DECIMAL(6,2) NOT NULL DEFAULT 0,
  sgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst_percent      DECIMAL(6,2) NOT NULL DEFAULT 0,
  igst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  cess_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  line_total        DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_eligibility   VARCHAR(20) NOT NULL DEFAULT 'Eligible',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pbi_bill (bill_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Phase 11-18: GST Input (ITC) register --------------------------------
CREATE TABLE IF NOT EXISTS finance_gst_input (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  gst_input_id          VARCHAR(30) NOT NULL,
  source                VARCHAR(40) NOT NULL DEFAULT 'Purchase Bill',
  source_bill_id        VARCHAR(30) NOT NULL,
  source_bill_ref       VARCHAR(60) DEFAULT NULL,
  bill_number           VARCHAR(120) DEFAULT NULL,
  bill_date             DATE DEFAULT NULL,
  period                VARCHAR(7) DEFAULT NULL,   -- YYYY-MM
  quarter               VARCHAR(7) DEFAULT NULL,   -- e.g. 2026-Q1
  financial_year        VARCHAR(12) DEFAULT NULL,
  vendor_id             VARCHAR(40) DEFAULT NULL,
  vendor_name           VARCHAR(255) DEFAULT NULL,
  vendor_gstin          VARCHAR(20) DEFAULT NULL,
  vendor_state          VARCHAR(120) DEFAULT NULL,
  vendor_state_code     VARCHAR(6) DEFAULT NULL,
  place_of_supply       VARCHAR(120) DEFAULT NULL,
  supply_type           VARCHAR(20) DEFAULT NULL,
  taxable_amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  gst_rate              DECIMAL(6,2) NOT NULL DEFAULT 0,
  cgst_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
  cess_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_gst             DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_eligible          TINYINT(1) NOT NULL DEFAULT 1,
  itc_section           VARCHAR(40) DEFAULT 'Input Services',
  itc_gross             DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_eligible_amount   DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_ineligible_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_reversal_amount   DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_net               DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_cgst              DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_sgst              DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_igst              DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_cess              DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_claimed           TINYINT(1) NOT NULL DEFAULT 0,
  claimed_period        VARCHAR(7) DEFAULT NULL,
  reconciliation_status VARCHAR(20) NOT NULL DEFAULT 'Unreconciled',
  gstr2b_reference      VARCHAR(120) DEFAULT NULL,
  gstr2b_taxable        DECIMAL(14,2) DEFAULT NULL,
  gstr2b_tax            DECIMAL(14,2) DEFAULT NULL,
  match_variance        DECIMAL(14,2) DEFAULT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'Available',
  narration             VARCHAR(500) DEFAULT NULL,
  created_by            INT DEFAULT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gin_source (source, source_bill_id),
  UNIQUE KEY uq_gin_id (gst_input_id),
  KEY idx_gin_period (period),
  KEY idx_gin_quarter (quarter),
  KEY idx_gin_vendor_gstin (vendor_gstin),
  KEY idx_gin_recon (reconciliation_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Phase 17/18: GSTR-2B staging (auto-populated from bills) --------------
CREATE TABLE IF NOT EXISTS finance_gstr2b (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  period            VARCHAR(7) NOT NULL,
  supplier_gstin    VARCHAR(20) DEFAULT NULL,
  supplier_name     VARCHAR(255) DEFAULT NULL,
  bill_number       VARCHAR(120) DEFAULT NULL,
  bill_date         DATE DEFAULT NULL,
  taxable_amount    DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  cess_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_tax         DECIMAL(14,2) NOT NULL DEFAULT 0,
  source            VARCHAR(30) NOT NULL DEFAULT 'Draft',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_g2b_period (period),
  KEY idx_g2b_gstin (supplier_gstin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Phase 10: effective-dated tax master ---------------------------------
DELIMITER $$
DROP PROCEDURE IF EXISTS `__gin_add_column` $$
CREATE PROCEDURE `__gin_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
     ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$
DELIMITER ;

CALL `__gin_add_column`('finance_tax_rates', 'effective_from', "effective_from DATE DEFAULT NULL");
CALL `__gin_add_column`('finance_tax_rates', 'effective_to',   "effective_to DATE DEFAULT NULL");
CALL `__gin_add_column`('finance_tax_rates', 'status',         "status VARCHAR(20) NOT NULL DEFAULT 'Active'");

DROP PROCEDURE IF EXISTS `__gin_add_column`;
