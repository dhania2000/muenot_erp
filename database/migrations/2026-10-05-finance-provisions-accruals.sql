-- =============================================================================
-- Finance > Provisions & Accruals
-- =============================================================================
-- Mirrors the schema created at runtime by ensureRegisterModuleTables()
-- (lib/finance-ensure.ts). Idempotent: safe to run on a fresh or existing DB.
-- MySQL 8 / InnoDB / utf8mb4.
--
-- provisions_accruals is a transactional register table. Its accounting is
-- posted through the shared register -> Journal -> General Ledger engine; the
-- posting_* columns are written only by that posting engine.
-- =============================================================================

CREATE TABLE IF NOT EXISTS provisions_accruals (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  provision_id        VARCHAR(30) NOT NULL,
  provision_name      VARCHAR(255) DEFAULT NULL,
  provision_type      VARCHAR(60) DEFAULT NULL,
  provision_date      DATE DEFAULT NULL,
  financial_year      VARCHAR(12) DEFAULT NULL,
  amount              DECIMAL(16,2) NOT NULL DEFAULT 0,
  related_party       VARCHAR(255) DEFAULT NULL,
  status              VARCHAR(30) NOT NULL DEFAULT 'Open',
  notes               TEXT DEFAULT NULL,

  -- Shared posting columns (written only by the register posting engine)
  posting_status      VARCHAR(20) NOT NULL DEFAULT 'Unposted',
  voucher_no          VARCHAR(30) DEFAULT NULL,
  reversal_voucher_no VARCHAR(30) DEFAULT NULL,
  posted_amount       DECIMAL(16,2) NOT NULL DEFAULT 0,
  posted_snapshot     LONGTEXT DEFAULT NULL,
  posted_at           DATETIME DEFAULT NULL,

  -- Audit
  created_by          INT DEFAULT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_prv_id (provision_id),
  KEY idx_prv_fy (financial_year),
  KEY idx_prv_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
