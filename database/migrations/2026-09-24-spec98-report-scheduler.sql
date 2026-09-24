-- =============================================================================
-- SPEC 98 — Report Scheduler
-- -----------------------------------------------------------------------------
-- Schedules saved reports (SPEC 97) for daily / weekly / monthly / custom-cron
-- delivery to email or storage, as PDF / Excel / CSV. report_schedules is the
-- schedule config; report_schedule_runs is one row per fired slot, holding the
-- generated artifact, delivery outcome and a UNIQUE (schedule, slot) guard that
-- prevents duplicate runs of the same slot.
--
-- The application self-heals these tables at runtime
-- (lib/reports/scheduler-store.ts); this migration is the canonical, idempotent
-- record of that schema.
-- =============================================================================

CREATE TABLE IF NOT EXISTS report_schedules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT NULL,
  report_id BIGINT UNSIGNED NOT NULL,
  report_name VARCHAR(200) NOT NULL,
  frequency ENUM('daily','weekly','monthly','custom') NOT NULL,
  cron_expression VARCHAR(120) NOT NULL,
  timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
  format ENUM('pdf','xlsx','csv') NOT NULL DEFAULT 'pdf',
  channel ENUM('email','storage') NOT NULL DEFAULT 'email',
  recipients TEXT NULL,
  status ENUM('active','paused') NOT NULL DEFAULT 'active',
  last_run_at DATETIME NULL,
  last_status VARCHAR(20) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_report_schedules_tenant (tenant_id, status),
  KEY idx_report_schedules_report (report_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS report_schedule_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  schedule_id BIGINT UNSIGNED NOT NULL,
  tenant_id INT NULL,
  slot VARCHAR(20) NOT NULL,
  status ENUM('running','success','failed','skipped') NOT NULL DEFAULT 'running',
  format ENUM('pdf','xlsx','csv') NOT NULL,
  channel ENUM('email','storage') NOT NULL,
  row_count INT UNSIGNED NOT NULL DEFAULT 0,
  byte_size INT UNSIGNED NOT NULL DEFAULT 0,
  recipients_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  file_name VARCHAR(255) NULL,
  content_type VARCHAR(150) NULL,
  artifact LONGBLOB NULL,
  token_salt VARCHAR(48) NULL,
  expires_at DATETIME NULL,
  error TEXT NULL,
  trigger_source ENUM('scheduler','manual') NOT NULL DEFAULT 'scheduler',
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_report_run_slot (schedule_id, slot),
  KEY idx_report_runs_schedule (schedule_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
