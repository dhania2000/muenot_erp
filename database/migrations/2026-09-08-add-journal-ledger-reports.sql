-- Journal Entries, General Ledger and Financial Reports.
--
-- Adds the two dedicated tables the config-driven CRUD factory targets for the
-- "journal-entries" and "general-ledger" Finance modules (matching the field
-- keys in lib/finance-module-configs.ts and the pasted column spec), plus a
-- lightweight saved-report log for the Financial Reports hub.
--
-- Column type conventions mirror 2026-09-07-add-finance-dedicated-tables.sql:
--   ids .................. VARCHAR(40)
--   names ................ VARCHAR(190)
--   money / amounts ...... DECIMAL(14,2)
--   selects / short text . VARCHAR(40-120)
--   long text ............ TEXT

-- ---------------------------------------------------------------------------
-- 1. Journal Entries  (JE-#### id, editable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  journal_entry_id VARCHAR(40) NOT NULL,
  journal_date DATE DEFAULT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  reference_type VARCHAR(40) DEFAULT NULL,
  reference_no VARCHAR(80) DEFAULT NULL,
  voucher_type VARCHAR(40) DEFAULT NULL,
  narration TEXT,
  account_id VARCHAR(40) DEFAULT NULL,
  account_name VARCHAR(190) DEFAULT NULL,
  account_group VARCHAR(80) DEFAULT NULL,
  account_type VARCHAR(80) DEFAULT NULL,
  party_id VARCHAR(40) DEFAULT NULL,
  party_name VARCHAR(190) DEFAULT NULL,
  project_id VARCHAR(40) DEFAULT NULL,
  project_name VARCHAR(190) DEFAULT NULL,
  debit DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  payment_mode VARCHAR(40) DEFAULT NULL,
  cheque_utr_reference VARCHAR(120) DEFAULT NULL,
  source_module VARCHAR(60) DEFAULT NULL,
  source_reference VARCHAR(120) DEFAULT NULL,
  approval_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  approved_by VARCHAR(190) DEFAULT NULL,
  posting_status VARCHAR(30) NOT NULL DEFAULT 'Unposted',
  posting_date DATE DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_journal_entry_id (journal_entry_id),
  KEY idx_je_date (journal_date),
  KEY idx_je_fy (financial_year),
  KEY idx_je_account (account_name),
  KEY idx_je_status (approval_status),
  KEY idx_je_posting (posting_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. General Ledger  (GL-#### id, editable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS general_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ledger_id VARCHAR(40) NOT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  transaction_date DATE DEFAULT NULL,
  value_date DATE DEFAULT NULL,
  month VARCHAR(20) DEFAULT NULL,
  account_id VARCHAR(40) DEFAULT NULL,
  account_name VARCHAR(190) DEFAULT NULL,
  account_group VARCHAR(80) DEFAULT NULL,
  account_type VARCHAR(80) DEFAULT NULL,
  transaction_type VARCHAR(40) DEFAULT NULL,
  voucher_type VARCHAR(40) DEFAULT NULL,
  reference_no VARCHAR(80) DEFAULT NULL,
  party_id VARCHAR(40) DEFAULT NULL,
  party_name VARCHAR(190) DEFAULT NULL,
  project_id VARCHAR(40) DEFAULT NULL,
  project_name VARCHAR(190) DEFAULT NULL,
  description TEXT,
  debit DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  balance DECIMAL(14,2) NOT NULL DEFAULT 0,
  balance_type VARCHAR(20) DEFAULT NULL,
  payment_mode VARCHAR(40) DEFAULT NULL,
  cheque_utr_reference VARCHAR(120) DEFAULT NULL,
  source_module VARCHAR(60) DEFAULT NULL,
  source_reference VARCHAR(120) DEFAULT NULL,
  reconciliation_status VARCHAR(30) NOT NULL DEFAULT 'Unreconciled',
  reconciliation_date DATE DEFAULT NULL,
  journal_entry_id VARCHAR(40) DEFAULT NULL,
  attachment_link VARCHAR(255) DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_id (ledger_id),
  KEY idx_gl_date (transaction_date),
  KEY idx_gl_fy (financial_year),
  KEY idx_gl_account (account_name),
  KEY idx_gl_status (reconciliation_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Seed automatic record-id prefixes for the new modules (idempotent).
-- ---------------------------------------------------------------------------
INSERT INTO record_id_sequences (prefix, next_number) VALUES
  ('JE', 0), ('GL', 0)
ON DUPLICATE KEY UPDATE prefix = VALUES(prefix);
