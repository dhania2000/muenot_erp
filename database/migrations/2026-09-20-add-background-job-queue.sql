-- SPEC 42 — durable background job queue. Job types are validated in code;
-- this table stores data and operational state, never executable commands.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_background_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_type` VARCHAR(80) NOT NULL,
  `tenant_id` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `payload` JSON NOT NULL,
  `status` ENUM('queued','running','completed','failed','dead_letter','cancelled') NOT NULL DEFAULT 'queued',
  `priority` TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts` TINYINT UNSIGNED NOT NULL DEFAULT 3,
  `backoff_seconds` SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  `timeout_seconds` SMALLINT UNSIGNED NOT NULL DEFAULT 300,
  `concurrency_key` VARCHAR(160) NULL,
  `concurrency_limit` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `idempotency_key` VARCHAR(160) NOT NULL,
  `available_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `locked_at` DATETIME NULL,
  `worker_id` VARCHAR(120) NULL,
  `cancel_requested` TINYINT(1) NOT NULL DEFAULT 0,
  `started_at` DATETIME NULL,
  `completed_at` DATETIME NULL,
  `result` JSON NULL,
  `error_message` TEXT NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_background_job_idempotency` (`job_type`, `tenant_id`, `idempotency_key`),
  KEY `idx_background_job_ready` (`status`, `available_at`, `priority`),
  KEY `idx_background_job_tenant` (`tenant_id`, `status`, `created_at`),
  KEY `idx_background_job_concurrency` (`concurrency_key`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_background_job_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` BIGINT UNSIGNED NOT NULL,
  `event_type` VARCHAR(40) NOT NULL,
  `detail` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_background_job_event` (`job_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
