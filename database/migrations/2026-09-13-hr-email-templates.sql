-- HR Email Template Management (Phase 3)
-- Extends the minimal hr_email_templates table into a full, governed template
-- library: stable Template ID (HRET-0001), machine key, description, category,
-- audience, optional event mapping, plain-text alternative, lifecycle status,
-- versioning, and usage analytics. Backward compatible with the existing
-- automation layer, which reads subject/body where status = 'Active'.

CREATE TABLE IF NOT EXISTS hr_email_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body LONGTEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE hr_email_templates
  ADD COLUMN IF NOT EXISTS template_uid VARCHAR(40) NULL,
  ADD COLUMN IF NOT EXISTS template_key VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS description VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS category VARCHAR(60) NOT NULL DEFAULT 'General',
  ADD COLUMN IF NOT EXISTS audience VARCHAR(40) NOT NULL DEFAULT 'Employee',
  ADD COLUMN IF NOT EXISTS event_key VARCHAR(60) NULL,
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

-- Full lifecycle. Existing 'Active' rows stay valid.
ALTER TABLE hr_email_templates
  MODIFY COLUMN status ENUM('Draft','Active','Inactive','Archived') NOT NULL DEFAULT 'Draft';

CREATE UNIQUE INDEX uq_hr_email_templates_uid ON hr_email_templates (template_uid);
CREATE UNIQUE INDEX uq_hr_email_templates_key ON hr_email_templates (template_key);
CREATE INDEX idx_hr_email_templates_status ON hr_email_templates (status);
CREATE INDEX idx_hr_email_templates_category ON hr_email_templates (category);

-- Immutable snapshot of every saved revision for audit / rollback.
CREATE TABLE IF NOT EXISTS hr_email_template_versions (
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
  INDEX idx_hr_email_template_versions_tpl (template_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
