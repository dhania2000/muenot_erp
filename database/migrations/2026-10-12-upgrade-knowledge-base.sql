-- ---------------------------------------------------------------------------
-- Knowledge Base upgrade: enterprise KMS on top of the original kb_articles.
--
-- This mirrors the self-healing performed at runtime by lib/knowledge-base.ts
-- (ensureKbSchema). It is safe to run repeatedly. The library will create/patch
-- anything missing on first request, so applying this file is optional but keeps
-- the schema explicit and reviewable.
-- ---------------------------------------------------------------------------

-- Configurable categories.
ALTER TABLE kb_categories ADD COLUMN IF NOT EXISTS active TINYINT(1) NOT NULL DEFAULT 1;
ALTER TABLE kb_categories ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

-- Article lifecycle / metadata columns.
ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS article_code VARCHAR(40) NULL,
  ADD COLUMN IF NOT EXISTS content_type ENUM('article','sop','policy','faq','guide','template','training','announcement') NOT NULL DEFAULT 'article',
  ADD COLUMN IF NOT EXISTS summary VARCHAR(600) NULL,
  ADD COLUMN IF NOT EXISTS content MEDIUMTEXT NULL,
  ADD COLUMN IF NOT EXISTS subcategory VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS tags TEXT NULL,
  ADD COLUMN IF NOT EXISTS audience_type ENUM('all','department','designation','employees','management','admin') NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS audience_config JSON NULL,
  ADD COLUMN IF NOT EXISTS department VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS author_id INT NULL,
  ADD COLUMN IF NOT EXISTS author_name VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS owner_id INT NULL,
  ADD COLUMN IF NOT EXISTS owner_name VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS status ENUM('draft','in_review','scheduled','published','expired','archived','rejected') NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS publish_date DATETIME NULL,
  ADD COLUMN IF NOT EXISTS published_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS effective_date DATE NULL,
  ADD COLUMN IF NOT EXISTS review_date DATE NULL,
  ADD COLUMN IF NOT EXISTS expiry_date DATE NULL,
  ADD COLUMN IF NOT EXISTS expired_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS acknowledgement_required TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notify_in_app TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS notify_email TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pinned TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS keep_pinned_after_expiry TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS important TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS view_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS helpful_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS not_helpful_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recipients_finalized TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reviewer_id INT NULL,
  ADD COLUMN IF NOT EXISTS reviewer_name VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS review_note VARCHAR(1000) NULL,
  ADD COLUMN IF NOT EXISTS reject_reason VARCHAR(1000) NULL,
  ADD COLUMN IF NOT EXISTS source_module VARCHAR(60) NULL,
  ADD COLUMN IF NOT EXISTS source_record_id VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS duplicated_from INT NULL,
  ADD COLUMN IF NOT EXISTS updated_by INT NULL,
  ADD COLUMN IF NOT EXISTS updated_by_name VARCHAR(150) NULL;

-- Keep already-live articles visible after the status column is introduced.
UPDATE kb_articles
   SET status = 'published',
       published_at = COALESCE(published_at, created_at),
       publish_date = COALESCE(publish_date, created_at),
       content = COALESCE(NULLIF(content, ''), description),
       author_id = COALESCE(author_id, created_by),
       author_name = COALESCE(author_name, created_by_name),
       owner_id = COALESCE(owner_id, created_by),
       owner_name = COALESCE(owner_name, created_by_name)
 WHERE status IS NULL OR status = '';

UPDATE kb_articles SET article_code = CONCAT('KB-', YEAR(created_at), '-', LPAD(id, 6, '0'))
 WHERE article_code IS NULL OR article_code = '';

-- Companion tables -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_tags (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, tag VARCHAR(60) NOT NULL,
  UNIQUE KEY uniq_kb_tag (article_id, tag), KEY idx_kb_tag (tag));

CREATE TABLE IF NOT EXISTS kb_recipients (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_recipient (article_id, employee_id), KEY idx_kbr_employee (employee_id));

CREATE TABLE IF NOT EXISTS kb_reads (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_read (article_id, employee_id), KEY idx_kbrd_employee (employee_id));

CREATE TABLE IF NOT EXISTS kb_acknowledgements (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  acknowledged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_ack (article_id, employee_id), KEY idx_kback_employee (employee_id));

CREATE TABLE IF NOT EXISTS kb_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NULL, draft_key VARCHAR(64) NULL,
  file_name VARCHAR(255) NOT NULL, file_type VARCHAR(150) NULL, file_size INT NOT NULL DEFAULT 0,
  storage_url VARCHAR(1024) NOT NULL, uploaded_by INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kba_article (article_id), KEY idx_kba_draft (draft_key));

CREATE TABLE IF NOT EXISTS kb_audit (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NULL, user_id INT NULL, user_name VARCHAR(150) NULL,
  action VARCHAR(60) NOT NULL, detail VARCHAR(1000) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kbaudit_article (article_id), KEY idx_kbaudit_action (action));

CREATE TABLE IF NOT EXISTS kb_versions (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, version INT NOT NULL,
  heading VARCHAR(200) NOT NULL, summary VARCHAR(600) NULL, content MEDIUMTEXT NULL, category_id INT NULL,
  status VARCHAR(20) NULL, change_summary VARCHAR(500) NULL, edited_by INT NULL, edited_by_name VARCHAR(150) NULL,
  edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY idx_kbv_article (article_id));

CREATE TABLE IF NOT EXISTS kb_deliveries (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  channel ENUM('in_app','email') NOT NULL, status ENUM('created','sent','failed') NOT NULL DEFAULT 'created',
  error VARCHAR(500) NULL, attempts INT NOT NULL DEFAULT 0, sent_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_delivery (article_id, employee_id, channel), KEY idx_kbd_status (status));

CREATE TABLE IF NOT EXISTS kb_reminders (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NULL,
  kind VARCHAR(20) NOT NULL, reminder_no INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_reminder (article_id, employee_id, kind, reminder_no));

CREATE TABLE IF NOT EXISTS kb_feedback (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  helpful TINYINT(1) NOT NULL, comment VARCHAR(1000) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_feedback (article_id, employee_id));

CREATE TABLE IF NOT EXISTS kb_favorites (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_kb_favorite (article_id, employee_id));

CREATE TABLE IF NOT EXISTS kb_related (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, related_id INT NOT NULL,
  UNIQUE KEY uniq_kb_related (article_id, related_id));

CREATE TABLE IF NOT EXISTS kb_erp_links (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, source_module VARCHAR(60) NOT NULL,
  source_record_id VARCHAR(80) NOT NULL, label VARCHAR(200) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_erp_link (article_id, source_module, source_record_id));

CREATE TABLE IF NOT EXISTS kb_views (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kbview_emp (employee_id, viewed_at), KEY idx_kbview_article (article_id));

-- Granular RBAC features (fall back to knowledge-base.manage in code) ---------
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Approve knowledge base', 'knowledge-base.approve', 'Review, approve and reject submitted articles', 94
FROM modules WHERE slug = 'knowledge-base';

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Knowledge base analytics', 'knowledge-base.analytics', 'View read/acknowledgement analytics and feedback', 95
FROM modules WHERE slug = 'knowledge-base';

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Export knowledge base', 'knowledge-base.export', 'Export the article register to CSV', 96
FROM modules WHERE slug = 'knowledge-base';
