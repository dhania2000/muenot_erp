-- =====================================================================
-- HR Email Hub — Phase 1 foundation
-- ---------------------------------------------------------------------
-- Extends the existing hr_emails table into a central communication hub:
-- stable Email IDs (HRE-YYYY-NNNNNN), categories, source-module linkage,
-- CC/BCC, manual vs. automated origin, scheduling + queue bookkeeping,
-- attachments and idempotent dedupe keys.
--
-- These ALTERs use `IF NOT EXISTS` (MariaDB / MySQL 8.0.29+). The same
-- changes are also applied idempotently at runtime by
-- ensureHrEmailHubSchema() in lib/hr-email.ts, so the feature keeps working
-- even if this migration has not been run manually in phpMyAdmin.
-- =====================================================================

ALTER TABLE hr_emails
  ADD COLUMN IF NOT EXISTS email_uid       VARCHAR(40)  NULL AFTER id,
  ADD COLUMN IF NOT EXISTS category        VARCHAR(60)  NOT NULL DEFAULT 'General',
  ADD COLUMN IF NOT EXISTS source_module   VARCHAR(40)  NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_record_id VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS cc              TEXT         NULL,
  ADD COLUMN IF NOT EXISTS bcc             TEXT         NULL,
  ADD COLUMN IF NOT EXISTS email_type      ENUM('Manual','Automated') NOT NULL DEFAULT 'Manual',
  ADD COLUMN IF NOT EXISTS scheduled_at    DATETIME     NULL,
  ADD COLUMN IF NOT EXISTS attempts        INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error      VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS dedupe_key      VARCHAR(190) NULL,
  ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS attachment_size INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Expand the status lifecycle beyond Sent/Failed/Draft.
ALTER TABLE hr_emails
  MODIFY COLUMN status ENUM('Draft','Scheduled','Queued','Sending','Sent','Failed','Cancelled')
  NOT NULL DEFAULT 'Sent';

-- Unique Email ID, dedupe guard (MySQL allows many NULLs in a UNIQUE index),
-- and a dispatcher-friendly index over the scheduling queue.
ALTER TABLE hr_emails
  ADD UNIQUE KEY IF NOT EXISTS uq_hr_emails_uid (email_uid),
  ADD UNIQUE KEY IF NOT EXISTS uq_hr_emails_dedupe (dedupe_key),
  ADD KEY IF NOT EXISTS idx_hr_emails_status (status),
  ADD KEY IF NOT EXISTS idx_hr_emails_category (category),
  ADD KEY IF NOT EXISTS idx_hr_emails_queue (status, scheduled_at),
  ADD KEY IF NOT EXISTS idx_hr_emails_source (source_module, source_record_id);

-- Backfill an origin for any legacy rows that predate these columns.
UPDATE hr_emails SET source_module = 'manual' WHERE source_module IS NULL OR source_module = '';
UPDATE hr_emails SET category = 'General' WHERE category IS NULL OR category = '';

-- ---------------------------------------------------------------------
-- Granular HR email permissions (legacy feature rows). Under the matrix
-- model these resolve onto the hr.emails module (send/schedule/bulk =>
-- update, view tracking => view); the rows also drive the legacy grant path.
-- ---------------------------------------------------------------------
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Send HR Email','hr.send_email','Compose and send HR emails',32 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Send Bulk HR Email','hr.send_bulk_email','Send HR emails to multiple recipients',33 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Schedule HR Email','hr.schedule_email','Queue HR emails to send later',34 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'View Email Tracking','hr.view_email_tracking','See opens and delivery status',35 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Send Sensitive HR Email','hr.send_sensitive_email','Send confidential/warning category emails',36 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Manage Email Automation','hr.manage_email_automation','Configure automated HR email rules',37 FROM modules WHERE slug='hr';
