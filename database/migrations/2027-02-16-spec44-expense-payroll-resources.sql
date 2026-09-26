-- SPEC 44 (#202-206) — expense reimbursement, payroll reconciliation and
-- resource-conflict resolution. All statements are idempotent; the app also
-- self-heals these on first use.

-- #202 partial reimbursement tracking on expense claims
-- The expense-claim table is normally created lazily on first use by the app
-- (lib/expense-claims.ts). Recreate it here so this migration is self-contained
-- and can run against a fresh database that has never booted the app.
CREATE TABLE IF NOT EXISTS hr_expense_claims (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  claim_id VARCHAR(30) NOT NULL,
  title VARCHAR(190) DEFAULT NULL,
  employee_id VARCHAR(40) DEFAULT NULL,
  employee_name VARCHAR(190) DEFAULT NULL,
  department VARCHAR(120) DEFAULT NULL,
  designation VARCHAR(120) DEFAULT NULL,
  employee_email VARCHAR(190) DEFAULT NULL,
  employee_manager VARCHAR(160) DEFAULT NULL,
  claim_date DATE DEFAULT NULL,
  period_from DATE DEFAULT NULL,
  period_to DATE DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  `lines` LONGTEXT DEFAULT NULL,
  gross_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  reimbursable_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  corporate_card_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  mileage_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  policy_violations LONGTEXT DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  submitted_at DATETIME DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  approved_by_id INT DEFAULT NULL,
  approved_by_name VARCHAR(190) DEFAULT NULL,
  rejected_reason VARCHAR(500) DEFAULT NULL,
  finance_expense_id VARCHAR(30) DEFAULT NULL,
  voucher_no VARCHAR(40) DEFAULT NULL,
  posted_at DATETIME DEFAULT NULL,
  reimbursed_at DATETIME DEFAULT NULL,
  reimbursed_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  reimbursement_reference VARCHAR(120) DEFAULT NULL,
  created_by INT DEFAULT NULL,
  created_by_name VARCHAR(190) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_claim_id (claim_id),
  KEY idx_claim_tenant (tenant_id),
  KEY idx_claim_employee (employee_id),
  KEY idx_claim_status (status),
  KEY idx_claim_creator (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_expense_claims' AND COLUMN_NAME = 'reimbursed_amount');
SET @sql := IF(@col = 0,
  'ALTER TABLE hr_expense_claims ADD COLUMN reimbursed_amount DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER reimbursed_at',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- #203 payroll runs (attendance x timesheets x tax)
CREATE TABLE IF NOT EXISTS hr_payroll_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED DEFAULT NULL,
  period CHAR(7) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  idempotency_key VARCHAR(120) DEFAULT NULL,
  employee_count INT UNSIGNED NOT NULL DEFAULT 0,
  gross DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_withheld DECIMAL(14,2) NOT NULL DEFAULT 0,
  net DECIMAL(14,2) NOT NULL DEFAULT 0,
  unreconciled_count INT UNSIGNED NOT NULL DEFAULT 0,
  tax_slabs JSON DEFAULT NULL,
  `lines` JSON DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  finalized_by INT UNSIGNED DEFAULT NULL,
  finalized_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payroll_run_idem (tenant_id, idempotency_key),
  KEY idx_payroll_run_period (tenant_id, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- #205-206 allocation conflict resolutions
CREATE TABLE IF NOT EXISTS operations_conflict_resolutions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED DEFAULT NULL,
  conflict_key VARCHAR(191) NOT NULL,
  resolution VARCHAR(30) NOT NULL,
  allocation_id VARCHAR(60) DEFAULT NULL,
  new_resource_id VARCHAR(60) DEFAULT NULL,
  new_hours DECIMAL(8,2) DEFAULT NULL,
  reason TEXT,
  resolved_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_conflict_resolution (tenant_id, conflict_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
