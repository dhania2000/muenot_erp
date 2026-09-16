-- =====================================================================
-- Finance :: Capital & Equity
-- Mirrors the schema created at runtime by ensureRegisterModuleTables()
-- (lib/finance-ensure.ts). Safe to run on a fresh or existing database.
-- MySQL 8 / InnoDB / utf8mb4.
-- =====================================================================

CREATE TABLE IF NOT EXISTS capital_equity (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  entry_id            VARCHAR(30) NOT NULL,
  entry_type          VARCHAR(60) DEFAULT NULL,
  contributor_name    VARCHAR(255) DEFAULT NULL,
  entry_date          DATE DEFAULT NULL,
  financial_year      VARCHAR(12) DEFAULT NULL,
  amount              DECIMAL(16,2) NOT NULL DEFAULT 0,
  mode                VARCHAR(40) DEFAULT NULL,
  transfer_source     VARCHAR(60) DEFAULT NULL,
  direction           VARCHAR(20) DEFAULT NULL,
  instrument          VARCHAR(120) DEFAULT NULL,
  status              VARCHAR(30) NOT NULL DEFAULT 'Active',
  notes               TEXT DEFAULT NULL,
  -- shared register posting columns
  posting_status      VARCHAR(20) NOT NULL DEFAULT 'unposted',
  voucher_no          VARCHAR(40) DEFAULT NULL,
  reversal_voucher_no VARCHAR(40) DEFAULT NULL,
  posted_amount       DECIMAL(16,2) DEFAULT NULL,
  posted_snapshot     JSON DEFAULT NULL,
  posted_at           DATETIME DEFAULT NULL,
  -- audit
  created_by          INT DEFAULT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cap_id (entry_id),
  KEY idx_cap_fy (financial_year),
  KEY idx_cap_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
