-- Spec48 — Enterprise import & export pipelines (#41-42, #98)
-- ---------------------------------------------------------------------------
-- Adds the STAGING + JOB tables that back the queued, resumable, 100k+ row
-- batch importer (lib/data-import-batches-store.ts). These SIT ON TOP of the
-- existing Import Center: the row pipeline (map → validate → dedupe → commit),
-- the immutable audit log, rollback and error reporting are all reused. No new
-- export tables are introduced — CSV/Excel/JSON and full-tenant export reuse
-- data_export_jobs, and the full backup package reuses the backup subsystem.
--
-- The store also self-heals this schema at runtime (same pattern as the rest of
-- the app), so this migration is the durable source of truth and both paths
-- converge. All tables are tenant-scoped; every query in the store carries a
-- tenant_id predicate.

CREATE TABLE IF NOT EXISTS `data_import_batch_jobs` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `dataset_key` VARCHAR(120) NOT NULL,
  `dataset_label` VARCHAR(190) NOT NULL,
  `adapter_key` VARCHAR(120) DEFAULT NULL,
  `file_name` VARCHAR(190) DEFAULT NULL,
  `target_table` VARCHAR(190) DEFAULT NULL,
  `tenant_column` VARCHAR(120) DEFAULT NULL,
  `status` VARCHAR(28) NOT NULL DEFAULT 'queued',
  `total_rows` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_batches` INT UNSIGNED NOT NULL DEFAULT 0,
  `batch_size` INT UNSIGNED NOT NULL DEFAULT 5000,
  `processed_batches` INT UNSIGNED NOT NULL DEFAULT 0,
  `imported_rows` INT UNSIGNED NOT NULL DEFAULT 0,
  `failed_rows` INT UNSIGNED NOT NULL DEFAULT 0,
  `skipped_rows` INT UNSIGNED NOT NULL DEFAULT 0,
  `mapping` JSON DEFAULT NULL,
  `error_report` LONGTEXT DEFAULT NULL,
  `imported_ids` LONGTEXT DEFAULT NULL,
  `has_id_pk` TINYINT(1) NOT NULL DEFAULT 0,
  `rolled_back` TINYINT(1) NOT NULL DEFAULT 0,
  `idempotency_key` VARCHAR(190) DEFAULT NULL,
  `requested_by` INT UNSIGNED DEFAULT NULL,
  `error` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `finished_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_batch_job_idem` (`tenant_id`, `idempotency_key`),
  KEY `idx_batch_job_tenant` (`tenant_id`, `created_at`),
  KEY `idx_batch_job_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Staged rows, one per source row, grouped into batches. `processed` flips to 1
-- only after its batch's rows are committed, making re-processing a batch a
-- no-op (idempotent) and letting an interrupted run resume from the checkpoint.
CREATE TABLE IF NOT EXISTS `data_import_batch_rows` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `batch_index` INT UNSIGNED NOT NULL,
  `row_number` INT UNSIGNED NOT NULL,
  `payload` JSON NOT NULL,
  `processed` TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_batch_rows_job_batch` (`job_id`, `batch_index`),
  KEY `idx_batch_rows_tenant` (`tenant_id`),
  CONSTRAINT `fk_batch_rows_job` FOREIGN KEY (`job_id`)
    REFERENCES `data_import_batch_jobs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
