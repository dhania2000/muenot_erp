-- Notice Board upgrade — complete, secure, automated lifecycle.
-- This migration is mirrored (and self-healed) at runtime by
-- lib/notice-board.ts -> ensureNoticeSchema(), so the app works even on
-- installs where this file has not been applied yet. Kept here for fresh
-- installs and documentation. All statements are idempotent.

-- --------------------------------------------------------------------------
-- notices: extend the existing table (heading/description preserved).
-- --------------------------------------------------------------------------
ALTER TABLE notices
  ADD COLUMN IF NOT EXISTS notice_code VARCHAR(30) NULL AFTER id,
  ADD COLUMN IF NOT EXISTS category VARCHAR(80) NOT NULL DEFAULT 'General' AFTER description,
  ADD COLUMN IF NOT EXISTS priority ENUM('normal','important','urgent') NOT NULL DEFAULT 'normal' AFTER category,
  ADD COLUMN IF NOT EXISTS status ENUM('draft','scheduled','published','expired','archived','cancelled') NOT NULL DEFAULT 'draft' AFTER priority,
  ADD COLUMN IF NOT EXISTS audience_type ENUM('all','department','designation','location','employment_type','employees') NOT NULL DEFAULT 'all' AFTER to_type,
  ADD COLUMN IF NOT EXISTS audience_config JSON NULL AFTER audience_type,
  ADD COLUMN IF NOT EXISTS include_inactive TINYINT(1) NOT NULL DEFAULT 0 AFTER audience_config,
  ADD COLUMN IF NOT EXISTS start_date DATE NULL AFTER include_inactive,
  ADD COLUMN IF NOT EXISTS end_date DATE NULL AFTER start_date,
  ADD COLUMN IF NOT EXISTS publish_date DATETIME NULL AFTER end_date,
  ADD COLUMN IF NOT EXISTS published_at DATETIME NULL AFTER publish_date,
  ADD COLUMN IF NOT EXISTS expired_at DATETIME NULL AFTER published_at,
  ADD COLUMN IF NOT EXISTS acknowledgement_required TINYINT(1) NOT NULL DEFAULT 0 AFTER expired_at,
  ADD COLUMN IF NOT EXISTS notify_in_app TINYINT(1) NOT NULL DEFAULT 1 AFTER acknowledgement_required,
  ADD COLUMN IF NOT EXISTS notify_email TINYINT(1) NOT NULL DEFAULT 0 AFTER notify_in_app,
  ADD COLUMN IF NOT EXISTS pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER notify_email,
  ADD COLUMN IF NOT EXISTS keep_pinned_after_expiry TINYINT(1) NOT NULL DEFAULT 0 AFTER pinned,
  ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(500) NULL AFTER keep_pinned_after_expiry,
  ADD COLUMN IF NOT EXISTS effective_date DATE NULL AFTER cancel_reason,
  ADD COLUMN IF NOT EXISTS review_date DATE NULL AFTER effective_date,
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1 AFTER review_date,
  ADD COLUMN IF NOT EXISTS recipients_finalized TINYINT(1) NOT NULL DEFAULT 0 AFTER version,
  ADD COLUMN IF NOT EXISTS updated_by INT NULL AFTER recipients_finalized,
  ADD COLUMN IF NOT EXISTS updated_by_name VARCHAR(150) NULL AFTER updated_by;

-- Legacy rows were live announcements — keep them visible.
UPDATE notices SET status = 'published' WHERE status = 'draft' AND created_at < (NOW() - INTERVAL 1 MINUTE) AND published_at IS NULL;
UPDATE notices SET published_at = created_at WHERE status = 'published' AND published_at IS NULL;
UPDATE notices SET audience_type = 'department' WHERE (audience_type = 'all') AND department IS NOT NULL AND department <> '';
UPDATE notices SET notice_code = CONCAT('NOT-', YEAR(created_at), '-', LPAD(id, 6, '0')) WHERE notice_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_notice_code ON notices (notice_code);
CREATE INDEX IF NOT EXISTS idx_notices_status ON notices (status);
CREATE INDEX IF NOT EXISTS idx_notices_category ON notices (category);
CREATE INDEX IF NOT EXISTS idx_notices_priority ON notices (priority);
CREATE INDEX IF NOT EXISTS idx_notices_publish_date ON notices (publish_date);
CREATE INDEX IF NOT EXISTS idx_notices_end_date ON notices (end_date);

-- --------------------------------------------------------------------------
-- Supporting tables
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notice_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_notice_category (name)
);

INSERT IGNORE INTO notice_categories (name, sort_order) VALUES
  ('General', 1), ('HR', 2), ('Finance', 3), ('IT', 4), ('Operations', 5),
  ('Sales', 6), ('Recruitment', 7), ('Policy', 8), ('Compliance', 9),
  ('Holiday', 10), ('Emergency', 11), ('Training', 12), ('Event', 13), ('Other', 14);

CREATE TABLE IF NOT EXISTS notice_recipients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_notice_recipient (notice_id, employee_id),
  KEY idx_nr_employee (employee_id),
  CONSTRAINT fk_nr_notice FOREIGN KEY (notice_id) REFERENCES notices (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notice_reads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_notice_read (notice_id, employee_id),
  KEY idx_nrd_employee (employee_id),
  CONSTRAINT fk_nrd_notice FOREIGN KEY (notice_id) REFERENCES notices (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notice_acknowledgements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  acknowledged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_notice_ack (notice_id, employee_id),
  KEY idx_nack_employee (employee_id),
  CONSTRAINT fk_nack_notice FOREIGN KEY (notice_id) REFERENCES notices (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notice_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NULL,
  draft_key VARCHAR(64) NULL,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(150) NULL,
  file_size INT NOT NULL DEFAULT 0,
  storage_url VARCHAR(1024) NOT NULL,
  uploaded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_na_notice (notice_id),
  KEY idx_na_draft (draft_key)
);

CREATE TABLE IF NOT EXISTS notice_audit (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NULL,
  user_id INT NULL,
  user_name VARCHAR(150) NULL,
  action VARCHAR(60) NOT NULL,
  detail VARCHAR(1000) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_naudit_notice (notice_id),
  KEY idx_naudit_action (action)
);

CREATE TABLE IF NOT EXISTS notice_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  version INT NOT NULL,
  heading VARCHAR(200) NOT NULL,
  description MEDIUMTEXT NOT NULL,
  category VARCHAR(80) NULL,
  priority VARCHAR(20) NULL,
  edited_by INT NULL,
  edited_by_name VARCHAR(150) NULL,
  edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_nv_notice (notice_id)
);

CREATE TABLE IF NOT EXISTS notice_deliveries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  channel ENUM('in_app','email') NOT NULL,
  status ENUM('created','sent','failed') NOT NULL DEFAULT 'created',
  error VARCHAR(500) NULL,
  attempts INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_notice_delivery (notice_id, employee_id, channel),
  KEY idx_nd_status (status),
  CONSTRAINT fk_nd_notice FOREIGN KEY (notice_id) REFERENCES notices (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notice_reminders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  reminder_no INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_notice_reminder (notice_id, employee_id, reminder_no),
  CONSTRAINT fk_nrem_notice FOREIGN KEY (notice_id) REFERENCES notices (id) ON DELETE CASCADE
);

-- --------------------------------------------------------------------------
-- RBAC features (management is enforced via notice-board.manage; these extra
-- rows document the granular capabilities available to admins).
-- --------------------------------------------------------------------------
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Publish notices', 'notice-board.publish', 'Publish, schedule, cancel and archive notices', 94 FROM modules WHERE slug = 'notice-board';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View notice analytics', 'notice-board.analytics', 'View read/acknowledgement analytics and export', 95 FROM modules WHERE slug = 'notice-board';
