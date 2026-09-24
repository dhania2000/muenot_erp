-- =============================================================================
-- SPEC 100 — Export Center
-- -----------------------------------------------------------------------------
-- Centralized export service. data_export_jobs tracks each requested export
-- through its lifecycle (queued -> processing -> completed / failed), storing
-- the generated artifact, redacted-field list, download token salt and expiry;
-- data_export_schedules drives recurring exports. Permission enforcement and
-- field redaction reuse the same centralized authorization as reports.
--
-- The application self-heals these tables at runtime (lib/data-export-store.ts);
-- this migration is the canonical, idempotent record of that schema.
-- =============================================================================

-- One row per export request.
CREATE TABLE IF NOT EXISTS `data_export_jobs` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `dataset_key` VARCHAR(120) NOT NULL,
  `scope_label` VARCHAR(190) NOT NULL,
  `format` VARCHAR(12) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'queued',
  `row_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `redacted_fields` TEXT DEFAULT NULL,
  `file_name` VARCHAR(190) DEFAULT NULL,
  `content_type` VARCHAR(120) DEFAULT NULL,
  `byte_size` INT UNSIGNED NOT NULL DEFAULT 0,
  `artifact` LONGBLOB DEFAULT NULL,
  `token_salt` VARCHAR(48) DEFAULT NULL,
  `trigger_source` VARCHAR(16) NOT NULL DEFAULT 'manual',
  `schedule_id` INT UNSIGNED DEFAULT NULL,
  `requested_by` INT UNSIGNED DEFAULT NULL,
  `error` TEXT DEFAULT NULL,
  `expires_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_export_job_tenant` (`tenant_id`, `created_at`),
  KEY `idx_export_job_schedule` (`schedule_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Recurring export configuration.
CREATE TABLE IF NOT EXISTS `data_export_schedules` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `dataset_key` VARCHAR(120) NOT NULL,
  `scope_label` VARCHAR(190) NOT NULL,
  `format` VARCHAR(12) NOT NULL,
  `frequency` VARCHAR(12) NOT NULL DEFAULT 'weekly',
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `last_run_at` TIMESTAMP NULL DEFAULT NULL,
  `next_run_at` TIMESTAMP NULL DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_export_schedule_tenant` (`tenant_id`),
  KEY `idx_export_schedule_due` (`status`, `next_run_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
