-- =============================================================
-- Purchase Bill accounting posting  (Phases 33–37, 104–107, 123, 148)
-- -------------------------------------------------------------
-- Wires Purchase Bills into the double-entry Journal + General Ledger:
--   * adds the posting linkage columns on purchase_bills (voucher_no,
--     reversal_voucher_no, posting_status, posted_at, posted_gross and the
--     frozen posted_snapshot used to unwind a reversal with the exact original
--     amounts);
--   * seeds the purchase-side Chart of Accounts (Purchases/Expenses, Input
--     CGST/SGST/IGST/Cess, Accounts Payable, TDS Payable) the posting engine
--     resolves by account_code.
--
-- The same columns + accounts are created idempotently at runtime by
-- ensurePurchaseBillColumns() (lib/finance-ensure.ts) and
-- ensurePurchasePostingAccounts() (lib/finance-accounts.ts), so existing
-- databases self-heal without this file. SAFE TO RE-RUN.
-- =============================================================

DELIMITER $$
DROP PROCEDURE IF EXISTS `__pbp_add_column` $$
CREATE PROCEDURE `__pbp_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$
DELIMITER ;

CALL `__pbp_add_column`('purchase_bills', 'voucher_no',          "voucher_no VARCHAR(40) DEFAULT NULL");
CALL `__pbp_add_column`('purchase_bills', 'reversal_voucher_no', "reversal_voucher_no VARCHAR(40) DEFAULT NULL");
CALL `__pbp_add_column`('purchase_bills', 'posting_status',      "posting_status VARCHAR(20) NOT NULL DEFAULT 'Unposted'");
CALL `__pbp_add_column`('purchase_bills', 'posted_at',           "posted_at DATETIME DEFAULT NULL");
CALL `__pbp_add_column`('purchase_bills', 'posted_gross',        "posted_gross DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `__pbp_add_column`('purchase_bills', 'posted_snapshot',     "posted_snapshot LONGTEXT DEFAULT NULL");

DROP PROCEDURE IF EXISTS `__pbp_add_column`;

-- ---- Purchase-side Chart of Accounts (only where the code is absent) -------
INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-PURCHASE', '5000', 'Purchases / Expenses', 'Expense', 'Direct Expense', 'Debit', 0, 0, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '5000');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-CGST-IN', '1410', 'Input CGST', 'Asset', 'Current Asset', 'Debit', 0, 1, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1410');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-SGST-IN', '1420', 'Input SGST', 'Asset', 'Current Asset', 'Debit', 0, 1, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1420');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-IGST-IN', '1430', 'Input IGST', 'Asset', 'Current Asset', 'Debit', 0, 1, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1430');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-CESS-IN', '1440', 'Input Cess', 'Asset', 'Current Asset', 'Debit', 0, 1, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1440');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-AP', '2000', 'Accounts Payable', 'Liability', 'Current Liability', 'Credit', 0, 0, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2000');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-TDS-PAY', '2150', 'TDS Payable', 'Liability', 'Duties & Taxes', 'Credit', 0, 0, 1, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2150');
