-- Marketing > Marketing Planner — production upgrade
-- Extends the minimal planner table into a full planning / scheduling /
-- assignment / review / dependency system and adds supporting tables.
--
-- NOTE: The application self-heals this schema at runtime via
-- `ensurePlannerSchema()` in lib/marketing/planner-db.ts, so running this file
-- is optional. It is provided for environments that manage schema via SQL and
-- as documentation of the target shape. All statements are idempotent-friendly
-- (guarded by IF NOT EXISTS or additive column adds).

-- Widen status from the original 4-value ENUM to a VARCHAR that fits the
-- expanded workflow (Draft, Assigned, Review, Blocked, Scheduled, Ready,
-- Completed, Cancelled, Archived).
ALTER TABLE marketing_planner_items
  MODIFY COLUMN status VARCHAR(40) NOT NULL DEFAULT 'Backlog';

-- Item master extensions (see planner-db.ts for the authoritative list).
ALTER TABLE marketing_planner_items
  ADD COLUMN IF NOT EXISTS content_type VARCHAR(60) NOT NULL DEFAULT 'Other',
  ADD COLUMN IF NOT EXISTS priority VARCHAR(16) NOT NULL DEFAULT 'Normal',
  ADD COLUMN IF NOT EXISTS start_date DATE NULL,
  ADD COLUMN IF NOT EXISTS campaign_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS journey_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS segment_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS email_template_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS whatsapp_template_name VARCHAR(191) NULL,
  ADD COLUMN IF NOT EXISTS brief JSON NULL,
  ADD COLUMN IF NOT EXISTS target_audience JSON NULL,
  ADD COLUMN IF NOT EXISTS estimated_budget DECIMAL(14,2) NULL,
  ADD COLUMN IF NOT EXISTS actual_spend DECIMAL(14,2) NULL,
  ADD COLUMN IF NOT EXISTS related_type VARCHAR(40) NULL,
  ADD COLUMN IF NOT EXISTS related_id VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS review_status VARCHAR(24) NOT NULL DEFAULT 'None',
  ADD COLUMN IF NOT EXISTS submitted_by INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS submitted_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS blocked_reason VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS blocked_by INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS blocked_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS ready_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS recurrence JSON NULL,
  ADD COLUMN IF NOT EXISTS recurrence_parent_id BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS next_recurrence_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS row_version INT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS marketing_planner_assignees (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'contributor',
  assigned_by INT UNSIGNED NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_planner_assignee (item_id, user_id),
  KEY idx_pa_user (user_id),
  KEY idx_pa_item (item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_dependencies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  depends_on_id BIGINT UNSIGNED NOT NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_planner_dep (item_id, depends_on_id),
  KEY idx_pd_item (item_id),
  KEY idx_pd_dep (depends_on_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'comment',
  user_id INT UNSIGNED NULL,
  body VARCHAR(2000) NOT NULL,
  meta JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pc_item (item_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  version INT NOT NULL,
  snapshot JSON NULL,
  change_summary VARCHAR(500) NULL,
  changed_by INT UNSIGNED NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pv_item (item_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_reminders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  stage VARCHAR(24) NOT NULL,
  due_at DATETIME NULL,
  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_planner_reminder (item_id, stage),
  KEY idx_pr_item (item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_activity (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(40) NOT NULL,
  field VARCHAR(60) NULL,
  old_value TEXT NULL,
  new_value TEXT NULL,
  reason VARCHAR(500) NULL,
  user_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pact_item (item_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_assets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  library_asset_id VARCHAR(64) NULL,
  label VARCHAR(255) NOT NULL,
  url VARCHAR(1000) NULL,
  kind VARCHAR(40) NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pas_item (item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Granular RBAC features (no-op when the marketing module row is absent).
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Assign Planner Work','marketing.planner.assign','Assign planner items to team members',92 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Approve Planner Content','marketing.planner.approve','Review and approve planner content',93 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Publish Planner Content','marketing.planner.publish','Mark planner content as published',94 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Export Planner Data','marketing.planner.export','Export planner metadata',95 FROM modules WHERE slug='marketing';
