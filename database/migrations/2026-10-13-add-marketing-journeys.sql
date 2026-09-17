-- Marketing > Journeys
-- Mirrors ensureJourneySchema() in lib/marketing/journeys-db.ts
-- Journeys, their steps, contact enrollments, step-run ledger, event log, and dedup.

CREATE TABLE IF NOT EXISTS marketing_journeys (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  journey_code VARCHAR(40) NOT NULL,
  name VARCHAR(190) NOT NULL,
  description VARCHAR(500) NULL,
  status ENUM('Draft','Active','Paused','Completed','Archived') NOT NULL DEFAULT 'Draft',
  trigger_type VARCHAR(40) NOT NULL DEFAULT 'manual',
  trigger_config JSON NULL,
  audience_config JSON NULL,
  goal_type VARCHAR(40) NULL,
  goal_config JSON NULL,
  owner_id INT UNSIGNED NULL,
  allow_reentry TINYINT(1) NOT NULL DEFAULT 0,
  allow_multiple_active TINYINT(1) NOT NULL DEFAULT 0,
  quiet_hours_start INT NULL,
  quiet_hours_end INT NULL,
  start_at DATETIME NULL,
  end_at DATETIME NULL,
  activated_at DATETIME NULL,
  archived_at DATETIME NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_journey_code (journey_code),
  KEY idx_j_status (status),
  KEY idx_j_trigger (trigger_type),
  KEY idx_j_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_journey_steps (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  journey_id BIGINT UNSIGNED NOT NULL,
  step_order INT NOT NULL DEFAULT 0,
  type VARCHAR(40) NOT NULL,
  name VARCHAR(190) NULL,
  config JSON NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_js_journey (journey_id),
  KEY idx_js_order (journey_id, step_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_journey_enrollments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  enrollment_code VARCHAR(40) NOT NULL,
  journey_id BIGINT UNSIGNED NOT NULL,
  contact_id BIGINT UNSIGNED NOT NULL,
  status ENUM('Active','Waiting','Completed','Paused','Exited','Failed') NOT NULL DEFAULT 'Active',
  current_step_order INT NOT NULL DEFAULT 0,
  next_run_at DATETIME NULL,
  goal_reached TINYINT(1) NOT NULL DEFAULT 0,
  exit_reason VARCHAR(190) NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'trigger',
  attempt_count INT NOT NULL DEFAULT 0,
  locked_at DATETIME NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_action_at DATETIME NULL,
  completed_at DATETIME NULL,
  enrolled_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_enrollment_code (enrollment_code),
  KEY idx_je_journey (journey_id),
  KEY idx_je_contact (contact_id),
  KEY idx_je_status (status),
  KEY idx_je_due (status, next_run_at),
  KEY idx_je_active (journey_id, contact_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_journey_step_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  enrollment_id BIGINT UNSIGNED NOT NULL,
  journey_id BIGINT UNSIGNED NOT NULL,
  step_id BIGINT UNSIGNED NULL,
  step_order INT NOT NULL DEFAULT 0,
  contact_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(40) NOT NULL,
  status ENUM('Completed','Skipped','Failed') NOT NULL DEFAULT 'Completed',
  idempotency_key VARCHAR(120) NOT NULL,
  result JSON NULL,
  error VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_step_run (idempotency_key),
  KEY idx_jsr_enrollment (enrollment_id),
  KEY idx_jsr_journey (journey_id),
  KEY idx_jsr_type (type),
  KEY idx_jsr_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_journey_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  journey_id BIGINT UNSIGNED NULL,
  enrollment_id BIGINT UNSIGNED NULL,
  contact_id BIGINT UNSIGNED NULL,
  step_id BIGINT UNSIGNED NULL,
  action VARCHAR(60) NOT NULL,
  detail VARCHAR(500) NULL,
  meta JSON NULL,
  actor_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_jev_journey (journey_id),
  KEY idx_jev_enrollment (enrollment_id),
  KEY idx_jev_contact (contact_id),
  KEY idx_jev_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_journey_event_dedup (
  event_key VARCHAR(191) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Permission matrix features (no-op when the marketing module row is absent).
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Journeys','marketing.journeys.view','View marketing automation journeys',80 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Manage Journeys','marketing.journeys.manage','Create, edit, activate and enroll into journeys',81 FROM modules WHERE slug='marketing';
