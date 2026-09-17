-- =============================================================================
-- Operations Module — Phases 16-25: Sync, Productivity, Scorecards, SLA tracking
-- -----------------------------------------------------------------------------
-- Extends the existing Operations sub-modules with the connective tissue the
-- earlier phases only scaffolded:
--   * Timesheets gain Start/End time + explicit non-billable hours (Phase 17).
--   * SLA Monitoring gains due/actual/delay tracking for auto breach detection
--     (Phase 23).
--   * A derived Productivity table (Phase 21) populated from Tasks, Timesheets,
--     Projects and Deliverables — never static values.
--   * Configurable Quality Scorecards + weighted criteria (Phases 22 & 24) with
--     an auto-calculated total.
--
-- No existing Operations table is dropped or replaced. Column additions use the
-- project's established "run once" convention (MySQL has no ADD COLUMN IF NOT
-- EXISTS); application code guards every new column with tableColumns() so an
-- install that has not run this migration degrades gracefully instead of
-- crashing. New tables use IF NOT EXISTS and are safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Phase 17 — Timesheets: Start/End time + non-billable hours
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_timesheets`
  ADD COLUMN `start_time`         TIME          NULL AFTER `work_date`,
  ADD COLUMN `end_time`           TIME          NULL AFTER `start_time`,
  ADD COLUMN `non_billable_hours` DECIMAL(8,2)  NULL AFTER `billable_hours`;

-- ---------------------------------------------------------------------------
-- Phase 23 — SLA Monitoring: due date, actual completion, computed delay
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_sla_monitoring`
  ADD COLUMN `due_date`          DATE  NULL AFTER `measurement_period`,
  ADD COLUMN `actual_completion` DATE  NULL AFTER `due_date`,
  ADD COLUMN `delay_days`        INT   NULL AFTER `actual_completion`;

-- ---------------------------------------------------------------------------
-- Phase 21 — Productivity (derived from Tasks + Timesheets + Deliverables)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_productivity (
  id INT AUTO_INCREMENT PRIMARY KEY,
  resource_id VARCHAR(191) DEFAULT NULL,
  resource_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  tasks_assigned INT DEFAULT NULL,
  tasks_completed INT DEFAULT NULL,
  deliverables_completed INT DEFAULT NULL,
  estimated_hours DECIMAL(10,2) DEFAULT NULL,
  logged_hours DECIMAL(10,2) DEFAULT NULL,
  billable_hours DECIMAL(10,2) DEFAULT NULL,
  task_completion_percent DECIMAL(6,2) DEFAULT NULL,
  efficiency_percent DECIMAL(6,2) DEFAULT NULL,
  billable_percent DECIMAL(6,2) DEFAULT NULL,
  productivity_score DECIMAL(6,2) DEFAULT NULL,
  source VARCHAR(32) DEFAULT 'derived',
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_productivity_resource_period (resource_id, period),
  KEY idx_productivity_period (period)
);

-- ---------------------------------------------------------------------------
-- Phases 22 & 24 — Quality Scorecards + configurable weighted criteria
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_scorecards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  scorecard_no VARCHAR(128) DEFAULT NULL,
  scorecard_type VARCHAR(64) DEFAULT NULL,
  subject_type VARCHAR(64) DEFAULT NULL,
  subject_id VARCHAR(191) DEFAULT NULL,
  subject_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  review_date DATE DEFAULT NULL,
  reviewer VARCHAR(255) DEFAULT NULL,
  total_score DECIMAL(10,2) DEFAULT NULL,
  max_score DECIMAL(10,2) DEFAULT NULL,
  score_percent DECIMAL(6,2) DEFAULT NULL,
  result VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_scorecard_subject (subject_type, subject_id),
  KEY idx_scorecard_project (project_id)
);

CREATE TABLE IF NOT EXISTS operations_scorecard_criteria (
  id INT AUTO_INCREMENT PRIMARY KEY,
  scorecard_id VARCHAR(191) DEFAULT NULL,
  criteria_name VARCHAR(255) DEFAULT NULL,
  weight DECIMAL(6,2) DEFAULT NULL,
  max_score DECIMAL(6,2) DEFAULT NULL,
  score DECIMAL(6,2) DEFAULT NULL,
  weighted_score DECIMAL(10,2) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_criteria_scorecard (scorecard_id)
);

-- ---------------------------------------------------------------------------
-- Feature slugs so the new sub-modules appear in the permission matrix and are
-- gated by the sidebar. IGNORE keeps this idempotent.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Productivity', 'operations.view_productivity', 'View operations productivity', 60 FROM modules WHERE slug = 'operations';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Quality Scorecards', 'operations.view_scorecards', 'View quality scorecards', 61 FROM modules WHERE slug = 'operations';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Scorecard Criteria', 'operations.view_scorecard_criteria', 'View scorecard criteria', 62 FROM modules WHERE slug = 'operations';
