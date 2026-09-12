-- HR Master Data productionization.
--
-- These statements are also applied idempotently at runtime by
-- ensureHrMasterSchema() in lib/hr-master-data.ts, so they are safe to run (or
-- re-run) against an existing production database. IDs of existing rows are
-- preserved; display codes are backfilled deterministically from the PK.

-- Shared audit trail for every HR master change (single table, not per-module).
CREATE TABLE IF NOT EXISTS hr_master_audit (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  module VARCHAR(40) NOT NULL,
  record_id VARCHAR(80) NOT NULL,
  action VARCHAR(40) NOT NULL,
  user_id INT NULL,
  user_name VARCHAR(150) NULL,
  old_value JSON NULL,
  new_value JSON NULL,
  source VARCHAR(40) NOT NULL DEFAULT 'master-data',
  remarks VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_hma_module (module),
  KEY idx_hma_record (module, record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Display-code columns for numeric-PK masters (kept alongside the numeric PK).
ALTER TABLE hr_promotions   ADD COLUMN promotion_code    VARCHAR(40) NULL;
ALTER TABLE hr_awards       ADD COLUMN award_code        VARCHAR(40) NULL;
ALTER TABLE hr_appreciations ADD COLUMN appreciation_code VARCHAR(40) NULL;
ALTER TABLE hr_holidays     ADD COLUMN holiday_code      VARCHAR(40) NULL;
ALTER TABLE hr_passport_visa ADD COLUMN pv_code          VARCHAR(40) NULL;

-- Promotion approval / effective-date audit columns.
ALTER TABLE hr_promotions ADD COLUMN approved_at TIMESTAMP NULL;
ALTER TABLE hr_promotions ADD COLUMN effected_at TIMESTAMP NULL;

-- Deterministic backfill of display codes for historical rows.
UPDATE hr_promotions    SET promotion_code    = CONCAT('PROM-', YEAR(created_at), '-', LPAD(promotion_id,6,'0'))          WHERE promotion_code IS NULL OR promotion_code = '';
UPDATE hr_awards        SET award_code        = CONCAT('AWD-',  YEAR(created_at), '-', LPAD(award_id,6,'0'))              WHERE award_code IS NULL OR award_code = '';
UPDATE hr_appreciations SET appreciation_code = CONCAT('APP-',  YEAR(created_at), '-', LPAD(appreciation_id,6,'0'))       WHERE appreciation_code IS NULL OR appreciation_code = '';
UPDATE hr_holidays      SET holiday_code      = CONCAT('HOL-',  COALESCE(year, YEAR(created_at)), '-', LPAD(holiday_id,6,'0')) WHERE holiday_code IS NULL OR holiday_code = '';
UPDATE hr_passport_visa SET pv_code          = CONCAT('PVR-',  LPAD(record_id,4,'0'))                                    WHERE pv_code IS NULL OR pv_code = '';

CREATE UNIQUE INDEX uniq_promotion_code    ON hr_promotions (promotion_code);
CREATE UNIQUE INDEX uniq_award_code        ON hr_awards (award_code);
CREATE UNIQUE INDEX uniq_appreciation_code ON hr_appreciations (appreciation_code);
CREATE UNIQUE INDEX uniq_holiday_code      ON hr_holidays (holiday_code);
CREATE UNIQUE INDEX uniq_pv_code           ON hr_passport_visa (pv_code);

-- Query-pattern indexes (spec §62).
CREATE INDEX idx_dept_status ON hr_departments (status);
CREATE INDEX idx_dept_parent ON hr_departments (parent_department_id);
CREATE INDEX idx_desg_status ON hr_designations (status);
CREATE INDEX idx_desg_parent ON hr_designations (parent_designation_id);
CREATE INDEX idx_prom_emp    ON hr_promotions (employee_id);
CREATE INDEX idx_prom_eff    ON hr_promotions (effective_date);
CREATE INDEX idx_prom_status ON hr_promotions (status);
CREATE INDEX idx_awd_emp     ON hr_awards (employee_id);
CREATE INDEX idx_app_emp     ON hr_appreciations (employee_id);
CREATE INDEX idx_pv_emp      ON hr_passport_visa (employee_id);
CREATE INDEX idx_pv_pexp     ON hr_passport_visa (passport_expiry_date);
CREATE INDEX idx_pv_vexp     ON hr_passport_visa (visa_expiry_date);
CREATE INDEX idx_hol_date    ON hr_holidays (holiday_date);
CREATE INDEX idx_hol_dept    ON hr_holidays (applicable_department_id);
CREATE INDEX idx_hol_status  ON hr_holidays (status);
