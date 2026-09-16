-- =====================================================================
-- Finance / Investments module
-- Mirrors the runtime schema created by ensureRegisterModuleTables()
-- in lib/finance-ensure.ts. Idempotent: safe on fresh or existing DBs.
-- MySQL 8 / InnoDB / utf8mb4.
-- =====================================================================

CREATE TABLE IF NOT EXISTS investments (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  investment_id         VARCHAR(30) NOT NULL,
  investment_name       VARCHAR(255) DEFAULT NULL,
  investment_type       VARCHAR(60) DEFAULT NULL,
  acquisition_date      DATE DEFAULT NULL,
  financial_year        VARCHAR(12) DEFAULT NULL,
  amount                DECIMAL(16,2) NOT NULL DEFAULT 0,
  funding_source        VARCHAR(40) DEFAULT NULL,
  units                 DECIMAL(16,4) NOT NULL DEFAULT 0,
  expected_return_rate  DECIMAL(6,2) NOT NULL DEFAULT 0,
  maturity_date         DATE DEFAULT NULL,
  current_value         DECIMAL(16,2) NOT NULL DEFAULT 0,
  status                VARCHAR(30) NOT NULL DEFAULT 'Active',
  notes                 TEXT DEFAULT NULL,
  -- shared posting columns (register -> Journal -> GL engine)
  posting_status        VARCHAR(20) NOT NULL DEFAULT 'Unposted',
  voucher_no            VARCHAR(30) DEFAULT NULL,
  reversal_voucher_no   VARCHAR(30) DEFAULT NULL,
  posted_amount         DECIMAL(16,2) NOT NULL DEFAULT 0,
  posted_snapshot       LONGTEXT DEFAULT NULL,
  posted_at             DATETIME DEFAULT NULL,
  created_by            INT DEFAULT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inv_id (investment_id),
  KEY idx_inv_fy (financial_year),
  KEY idx_inv_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
