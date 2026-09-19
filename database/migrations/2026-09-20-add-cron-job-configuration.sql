-- ============================================================================
-- SPEC 40 — Safe platform scheduled-job configuration.
-- The endpoint is always selected from the reviewed application allow-list;
-- this schema intentionally has no command or user-supplied URL column.
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_cron_jobs` (
  `job_key` VARCHAR(100) NOT NULL,
  `cron_expression` VARCHAR(120) NOT NULL,
  `timezone` VARCHAR(80) NOT NULL DEFAULT 'UTC',
  `start_at` DATETIME NULL,
  `end_at` DATETIME NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `retry_limit` TINYINT UNSIGNED NOT NULL DEFAULT 2,
  `timeout_seconds` SMALLINT UNSIGNED NOT NULL DEFAULT 300,
  `concurrency_limit` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `notify_on_failure` TINYINT(1) NOT NULL DEFAULT 1,
  `notification_emails` VARCHAR(1000) NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`job_key`),
  KEY `idx_platform_cron_enabled` (`enabled`),
  KEY `idx_platform_cron_schedule` (`cron_expression`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_cron_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_key` VARCHAR(100) NOT NULL,
  `scheduled_for` DATETIME NOT NULL,
  `status` ENUM('running','succeeded','failed','skipped') NOT NULL DEFAULT 'running',
  `attempt` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `started_at` DATETIME NOT NULL,
  `finished_at` DATETIME NULL,
  `duration_ms` INT UNSIGNED NULL,
  `error_message` TEXT NULL,
  `trigger_source` ENUM('scheduler','manual') NOT NULL DEFAULT 'scheduler',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_platform_cron_slot` (`job_key`, `scheduled_for`),
  KEY `idx_platform_cron_runs_status` (`status`, `started_at`),
  KEY `idx_platform_cron_runs_job` (`job_key`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_cron_audit` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_key` VARCHAR(100) NOT NULL,
  `action` VARCHAR(40) NOT NULL,
  `detail` JSON NULL,
  `actor_user_id` BIGINT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_platform_cron_audit_job` (`job_key`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
