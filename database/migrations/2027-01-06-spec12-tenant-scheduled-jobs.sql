-- Spec12 (#22-29): tenant scheduled jobs.
-- Tenant admins schedule REVIEWED actions (see lib/tenant-jobs/model.ts). Runs
-- are dispatched by the platform scheduler (cron key `tenant_scheduled_jobs`)
-- into the shared durable queue `platform_background_jobs` as job_type
-- `tenant.scheduled_job` with a per-tenant concurrency key. The same DDL is
-- applied idempotently at runtime by lib/tenant-jobs/store.ts.

CREATE TABLE IF NOT EXISTS `tenant_scheduled_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `action_key` VARCHAR(60) NOT NULL,
  `action_params` JSON NOT NULL,
  `preset_key` VARCHAR(40) NOT NULL DEFAULT 'custom',
  `cron_expression` VARCHAR(120) NOT NULL,
  `timezone` VARCHAR(64) NOT NULL,
  `start_at` DATETIME NULL,
  `end_at` DATETIME NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `max_attempts` TINYINT UNSIGNED NOT NULL DEFAULT 3,
  `notify_on_failure` TINYINT(1) NOT NULL DEFAULT 1,
  `notify_on_success` TINYINT(1) NOT NULL DEFAULT 0,
  `notify_emails` JSON NULL,
  `next_run_at` DATETIME NULL,
  `last_run_at` DATETIME NULL,
  `last_status` VARCHAR(20) NULL,
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `create_key` VARCHAR(160) NULL,
  `owner_user_id` BIGINT UNSIGNED NOT NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  `deleted_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tenant_job_create_key` (`tenant_id`, `create_key`),
  KEY `idx_tenant_job_due` (`enabled`, `deleted_at`, `next_run_at`),
  KEY `idx_tenant_job_tenant` (`tenant_id`, `deleted_at`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `tenant_scheduled_job_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `schedule_id` BIGINT UNSIGNED NOT NULL,
  `trigger_source` ENUM('scheduler','manual') NOT NULL DEFAULT 'scheduler',
  -- `slot:<iso>` for scheduled runs, `manual:<key>` for run-now. Unique per
  -- schedule so duplicate scheduler ticks / repeated clicks cannot double-run.
  `dedupe_key` VARCHAR(191) NOT NULL,
  `scheduled_for` DATETIME NOT NULL,
  `status` ENUM('pending','queued','running','succeeded','failed','skipped') NOT NULL DEFAULT 'pending',
  `skip_reason` VARCHAR(40) NULL,
  `background_job_id` BIGINT UNSIGNED NULL,
  `result` JSON NULL,
  `error_message` TEXT NULL,
  `triggered_by` BIGINT UNSIGNED NULL,
  `started_at` DATETIME NULL,
  `finished_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tenant_job_run_dedupe` (`schedule_id`, `dedupe_key`),
  KEY `idx_tenant_job_run_history` (`tenant_id`, `schedule_id`, `created_at`),
  KEY `idx_tenant_job_run_pending` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
