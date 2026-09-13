-- =============================================================
-- Purchase Bill master upgrade (Phases 1–5, additive & non-destructive)
-- -------------------------------------------------------------
-- Promotes `bill_id` (PB-2026-000001, server-generated & immutable) to the
-- business key, adds the frozen vendor snapshot, the place-of-supply / GST
-- split fields, the accounting heads and the document attachment columns.
--
-- The same columns + index changes are also applied idempotently at runtime by
-- ensurePurchaseBillColumns() in lib/finance-ensure.ts, so existing databases
-- self-heal without this migration. This file documents the target schema for
-- fresh installs.
--
-- SAFE TO RE-RUN. MySQL 8 has no reliable `ADD COLUMN IF NOT EXISTS`, so every
-- change goes through helper procedures that check information_schema first.
-- =============================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS `__pb_add_column` $$
CREATE PROCEDURE `__pb_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__pb_add_index` $$
CREATE PROCEDURE `__pb_add_index`(IN p_table VARCHAR(64), IN p_index VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_index
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__pb_drop_index` $$
CREATE PROCEDURE `__pb_drop_index`(IN p_table VARCHAR(64), IN p_index VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_index
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` DROP INDEX `', p_index, '`');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- ---- Phase 1: immutable, server-generated Bill ID -------------------------
CALL `__pb_add_column`('purchase_bills', 'bill_id', 'bill_id VARCHAR(30) DEFAULT NULL');

-- ---- Phase 4: bill information --------------------------------------------
CALL `__pb_add_column`('purchase_bills', 'bill_number',       'bill_number VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'grn_number',        'grn_number VARCHAR(60) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'accounting_period', 'accounting_period VARCHAR(20) DEFAULT NULL');

-- ---- Phase 2/3: frozen vendor snapshot ------------------------------------
CALL `__pb_add_column`('purchase_bills', 'vendor_legal_name',     'vendor_legal_name VARCHAR(255) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'vendor_gstin',          'vendor_gstin VARCHAR(20) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'vendor_pan',            'vendor_pan VARCHAR(15) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'vendor_tan',            'vendor_tan VARCHAR(15) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'vendor_state',          'vendor_state VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'vendor_state_code',     'vendor_state_code VARCHAR(6) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'gst_registration_type', 'gst_registration_type VARCHAR(40) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'gst_status',            'gst_status VARCHAR(40) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'currency',              'currency VARCHAR(10) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'payment_terms',         'payment_terms VARCHAR(40) DEFAULT NULL');

-- ---- Phase 4/9: billing + place of supply ---------------------------------
CALL `__pb_add_column`('purchase_bills', 'billing_address',      'billing_address TEXT DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'supply_location',      'supply_location VARCHAR(190) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'place_of_supply',      'place_of_supply VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'place_of_supply_code', 'place_of_supply_code VARCHAR(6) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'supply_type',          'supply_type VARCHAR(20) DEFAULT NULL');

-- ---- Phase 5: GST rate + TDS base -----------------------------------------
CALL `__pb_add_column`('purchase_bills', 'gst_rate', 'gst_rate DECIMAL(6,2) NOT NULL DEFAULT 0');
CALL `__pb_add_column`('purchase_bills', 'tds_base', 'tds_base DECIMAL(14,2) NOT NULL DEFAULT 0');

-- ---- Phase 4: accounting heads --------------------------------------------
CALL `__pb_add_column`('purchase_bills', 'expense_account', 'expense_account VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'payable_account', 'payable_account VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'cost_centre',     'cost_centre VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'department',      'department VARCHAR(120) DEFAULT NULL');

-- ---- Phase 4: document attachments ----------------------------------------
CALL `__pb_add_column`('purchase_bills', 'bill_attachment_url', 'bill_attachment_url VARCHAR(500) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'po_document_url',     'po_document_url VARCHAR(500) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'grn_document_url',    'grn_document_url VARCHAR(500) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'supporting_docs_url', 'supporting_docs_url TEXT DEFAULT NULL');

-- ---- Backfill a stable immutable id for any pre-existing rows --------------
UPDATE purchase_bills
   SET bill_id = CONCAT('PB-LEGACY-', LPAD(id, 6, '0'))
 WHERE bill_id IS NULL OR bill_id = '';

-- ---- Index changes: PO Number is now optional; Bill ID is the key ---------
CALL `__pb_drop_index`('purchase_bills', 'uq_purchase_po');
CALL `__pb_add_index`('purchase_bills', 'uq_pb_bill_id',      'UNIQUE KEY uq_pb_bill_id (bill_id)');
CALL `__pb_add_index`('purchase_bills', 'idx_pb_bill_number', 'KEY idx_pb_bill_number (bill_number)');

DROP PROCEDURE IF EXISTS `__pb_add_column`;
DROP PROCEDURE IF EXISTS `__pb_add_index`;
DROP PROCEDURE IF EXISTS `__pb_drop_index`;
