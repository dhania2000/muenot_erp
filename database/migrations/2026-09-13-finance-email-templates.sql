-- Finance Email Template Management
-- Extends the minimal finance_email_templates table into a full, governed
-- template library mirroring HR: stable Template ID (FNET-0001), machine key,
-- description, category, audience, plain-text alternative, lifecycle status,
-- versioning, and usage analytics. Backward compatible with the existing
-- finance email composer, which reads subject/body where status = 'Active'.

CREATE TABLE IF NOT EXISTS finance_email_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body LONGTEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE finance_email_templates
  ADD COLUMN IF NOT EXISTS template_uid VARCHAR(40) NULL,
  ADD COLUMN IF NOT EXISTS template_key VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS description VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS category VARCHAR(60) NOT NULL DEFAULT 'General',
  ADD COLUMN IF NOT EXISTS audience VARCHAR(40) NOT NULL DEFAULT 'Customer',
  ADD COLUMN IF NOT EXISTS body_text LONGTEXT NULL,
  ADD COLUMN IF NOT EXISTS version INT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS usage_count INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS attachment_size INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS created_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS updated_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Full lifecycle. Existing 'Active'/'Inactive' rows stay valid.
ALTER TABLE finance_email_templates
  MODIFY COLUMN status ENUM('Draft','Active','Inactive','Archived') NOT NULL DEFAULT 'Draft';

-- MySQL has no `CREATE INDEX IF NOT EXISTS`, so guard each index against
-- information_schema to keep this migration safely re-runnable.
SET @exist := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'finance_email_templates'
  AND index_name = 'uq_finance_email_templates_uid');
SET @sql := IF(@exist = 0,
  'CREATE UNIQUE INDEX uq_finance_email_templates_uid ON finance_email_templates (template_uid)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'finance_email_templates'
  AND index_name = 'uq_finance_email_templates_key');
SET @sql := IF(@exist = 0,
  'CREATE UNIQUE INDEX uq_finance_email_templates_key ON finance_email_templates (template_key)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'finance_email_templates'
  AND index_name = 'idx_finance_email_templates_status');
SET @sql := IF(@exist = 0,
  'CREATE INDEX idx_finance_email_templates_status ON finance_email_templates (status)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'finance_email_templates'
  AND index_name = 'idx_finance_email_templates_category');
SET @sql := IF(@exist = 0,
  'CREATE INDEX idx_finance_email_templates_category ON finance_email_templates (category)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Immutable snapshot of every saved revision for audit / rollback.
CREATE TABLE IF NOT EXISTS finance_email_template_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body LONGTEXT NOT NULL,
  body_text LONGTEXT NULL,
  category VARCHAR(60) NULL,
  audience VARCHAR(40) NULL,
  status VARCHAR(20) NULL,
  changed_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_finance_email_template_versions_tpl (template_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
