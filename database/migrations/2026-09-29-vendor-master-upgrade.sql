-- =============================================================
-- Vendor master upgrade (additive, non-destructive)
-- -------------------------------------------------------------
-- Adds the vendor-first master columns and the GSTIN verification
-- snapshot columns to `customers_vendors`, plus the indexes that back
-- the list filters (status, category, GST status) and the GSTIN
-- duplicate lookup.
--
-- The same columns are also created idempotently at runtime by
-- ensureCustomerVendorGstColumns() in lib/finance-ensure.ts, so existing
-- databases self-heal without this migration. This file documents the
-- target schema for fresh installs and adds the supporting indexes that
-- the runtime helper does not create.
--
-- SAFE TO RE-RUN. MySQL 8 has no reliable `ADD COLUMN IF NOT EXISTS`, so
-- every column / index change goes through helper procedures that check
-- information_schema first and skip anything that already exists.
-- =============================================================

DELIMITER $$

-- Adds a column only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__vm_add_column` $$
CREATE PROCEDURE `__vm_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
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
DROP PROCEDURE IF EXISTS `__vm_add_index` $$
CREATE PROCEDURE `__vm_add_index`(IN p_table VARCHAR(64), IN p_index VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_index
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- ---- Vendor master columns (mirror lib/finance-ensure.ts) -----------------
CALL `__vm_add_column`('customers_vendors', 'trade_name',              'trade_name VARCHAR(255) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'vendor_category',         'vendor_category VARCHAR(60) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'registered_address',      'registered_address TEXT DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'upi_id',                  'upi_id VARCHAR(120) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'tds_applicable',          'tds_applicable TINYINT(1) NOT NULL DEFAULT 0');
CALL `__vm_add_column`('customers_vendors', 'kyc_status',              'kyc_status VARCHAR(30) DEFAULT NULL');

-- ---- GSTIN verification snapshot columns ----------------------------------
CALL `__vm_add_column`('customers_vendors', 'gst_trade_name',          'gst_trade_name VARCHAR(255) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_status',              'gst_status VARCHAR(40) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_taxpayer_type',       'gst_taxpayer_type VARCHAR(60) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'business_constitution',   'business_constitution VARCHAR(120) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_registration_date',   'gst_registration_date VARCHAR(20) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_cancellation_date',   'gst_cancellation_date VARCHAR(20) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_block_status',        'gst_block_status VARCHAR(40) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_verification_status', 'gst_verification_status VARCHAR(30) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_verified_at',         'gst_verified_at DATETIME DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_verification_source', 'gst_verification_source VARCHAR(60) DEFAULT NULL');

-- ---- Indexes backing the list filters and the GSTIN duplicate lookup ------
CALL `__vm_add_index`('customers_vendors', 'idx_cv_category',    'KEY idx_cv_category (vendor_category)');
CALL `__vm_add_index`('customers_vendors', 'idx_cv_gst_status',  'KEY idx_cv_gst_status (gst_verification_status)');
CALL `__vm_add_index`('customers_vendors', 'idx_cv_tds',         'KEY idx_cv_tds (tds_applicable)');
CALL `__vm_add_index`('customers_vendors', 'idx_cv_party_type',  'KEY idx_cv_party_type (party_type)');

-- The purchase-bills → vendor join (Vendor 360 + list outstanding) filters on
-- vendor_id; index it so the correlated outstanding subquery stays cheap.
CALL `__vm_add_index`('purchase_bills', 'idx_pb_vendor_id', 'KEY idx_pb_vendor_id (vendor_id)');

DROP PROCEDURE IF EXISTS `__vm_add_column`;
DROP PROCEDURE IF EXISTS `__vm_add_index`;
