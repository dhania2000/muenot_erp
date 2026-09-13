-- Finance posting + audit backbone.
--
-- Phase 1 of the Sales Invoice → General Ledger integration. This migration is
-- schema-only (no application data is touched) and is safe to run once against
-- the live database. It adds:
--
--   1. A voucher-grouping column on journal_entries + general_ledger so the
--      several debit/credit lines that make up one balanced posting can be tied
--      together (journal_entry_id stays unique per line; voucher_no groups them).
--   2. finance_audit_events — an append-only, tamper-evident trail of every
--      lifecycle action on a financial document (created / issued / posted /
--      payment recorded / cancelled / reversed).
--   3. A default Chart of Accounts (only inserted where the account_code is not
--      already present) so the posting engine has real accounts to target.
--
-- Column type conventions mirror the earlier finance migrations:
--   ids .......... VARCHAR(40)      names ........ VARCHAR(190)
--   money ........ DECIMAL(14,2)    selects ...... VARCHAR(20-80)
--
-- The ALTER/ADD steps are guarded with information_schema checks so the file is
-- idempotent and can be re-applied without error.

-- ---------------------------------------------------------------------------
-- 1. Voucher grouping columns (idempotent add).
-- ---------------------------------------------------------------------------
SET @has_je_voucher := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'journal_entries'
     AND column_name = 'voucher_no'
);
SET @sql := IF(@has_je_voucher = 0,
  'ALTER TABLE journal_entries
     ADD COLUMN voucher_no VARCHAR(40) DEFAULT NULL AFTER journal_entry_id,
     ADD KEY idx_je_voucher (voucher_no)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_gl_voucher := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'general_ledger'
     AND column_name = 'voucher_no'
);
SET @sql := IF(@has_gl_voucher = 0,
  'ALTER TABLE general_ledger
     ADD COLUMN voucher_no VARCHAR(40) DEFAULT NULL AFTER journal_entry_id,
     ADD KEY idx_gl_voucher (voucher_no)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Link a general_ledger row back to the source document (entity + id). These
-- complement the existing source_module / source_reference free-text columns
-- with a stable, queryable pair used by the posting engine and drill-downs.
SET @has_gl_srctype := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'general_ledger'
     AND column_name = 'source_entity_type'
);
SET @sql := IF(@has_gl_srctype = 0,
  'ALTER TABLE general_ledger
     ADD COLUMN source_entity_type VARCHAR(40) DEFAULT NULL AFTER source_reference,
     ADD COLUMN source_entity_id BIGINT UNSIGNED DEFAULT NULL AFTER source_entity_type,
     ADD KEY idx_gl_source_entity (source_entity_type, source_entity_id)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_je_srctype := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'journal_entries'
     AND column_name = 'source_entity_type'
);
SET @sql := IF(@has_je_srctype = 0,
  'ALTER TABLE journal_entries
     ADD COLUMN source_entity_type VARCHAR(40) DEFAULT NULL AFTER source_reference,
     ADD COLUMN source_entity_id BIGINT UNSIGNED DEFAULT NULL AFTER source_entity_type,
     ADD KEY idx_je_source_entity (source_entity_type, source_entity_id)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2. Finance audit events — append-only lifecycle trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity_type VARCHAR(40) NOT NULL,
  entity_pk BIGINT UNSIGNED DEFAULT NULL,
  entity_ref VARCHAR(60) DEFAULT NULL,
  event_type VARCHAR(60) NOT NULL,
  summary VARCHAR(255) NOT NULL,
  detail JSON DEFAULT NULL,
  amount DECIMAL(14,2) DEFAULT NULL,
  voucher_no VARCHAR(40) DEFAULT NULL,
  actor_id BIGINT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(190) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fae_entity (entity_type, entity_pk, created_at),
  KEY idx_fae_ref (entity_ref),
  KEY idx_fae_event (event_type),
  KEY idx_fae_voucher (voucher_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. Default Chart of Accounts (only where the code is not already present).
--    Codes here are the posting engine's built-in defaults; a company can add
--    its own accounts with the same codes and the engine will prefer those.
-- ---------------------------------------------------------------------------
INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-AR', '1200', 'Accounts Receivable',
  'Asset', 'Current Asset', 'Debit',
  0, 0, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1200');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-TDS-RECV', '1450', 'TDS Receivable', 'Asset', 'Current Asset', 'Debit',
  0, 0, 1, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1450');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-BANK', '1000', 'Bank Account', 'Asset', 'Bank', 'Debit',
  1, 0, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1000');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-CASH', '1010', 'Cash', 'Asset', 'Cash', 'Debit',
  1, 0, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1010');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-SALES', '4000', 'Sales Revenue', 'Income', 'Direct Income', 'Credit',
  0, 1, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '4000');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-CGST-OUT', '2110', 'Output CGST Payable', 'Liability', 'Duties & Taxes', 'Credit',
  0, 1, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2110');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-SGST-OUT', '2120', 'Output SGST Payable', 'Liability', 'Duties & Taxes', 'Credit',
  0, 1, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2120');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-IGST-OUT', '2130', 'Output IGST Payable', 'Liability', 'Duties & Taxes', 'Credit',
  0, 1, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2130');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-CESS-OUT', '2140', 'Output Cess Payable', 'Liability', 'Duties & Taxes', 'Credit',
  0, 1, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2140');

-- ---------------------------------------------------------------------------
-- 4. Record-id sequence for balanced-posting voucher numbers (VCH-####).
-- ---------------------------------------------------------------------------
INSERT INTO record_id_sequences (prefix, next_number) VALUES ('VCH', 0)
ON DUPLICATE KEY UPDATE prefix = VALUES(prefix);
