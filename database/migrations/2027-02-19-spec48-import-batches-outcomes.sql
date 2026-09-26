-- Spec48 follow-up — per-row outcomes, validation counts and progress history
-- for the queued batch importer (lib/data-import-batches-store.ts).
--
-- * data_import_batch_rows gains a per-row outcome + messages + inserted_id so
--   the row-level error report and rollback are unbounded (no JSON cap) and
--   exact, and (job_id, row_number) becomes unique so a retried upload chunk
--   is idempotent (INSERT IGNORE).
-- * data_import_batch_jobs stores the last validation pass and staged count.
-- * data_import_batch_events is the append-only progress history.
-- The store self-heals the same shape at runtime; both paths converge.

ALTER TABLE `data_import_batch_rows`
  ADD COLUMN `outcome` VARCHAR(16) DEFAULT NULL,
  ADD COLUMN `messages` TEXT DEFAULT NULL,
  ADD COLUMN `inserted_id` BIGINT UNSIGNED DEFAULT NULL,
  ADD UNIQUE KEY `uq_batch_rows_job_row` (`job_id`, `row_number`),
  ADD KEY `idx_batch_rows_outcome` (`job_id`, `outcome`);

ALTER TABLE `data_import_batch_jobs`
  ADD COLUMN `staged_rows` INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `headers` JSON DEFAULT NULL,
  ADD COLUMN `validation` JSON DEFAULT NULL,
  ADD COLUMN `requested_by_name` VARCHAR(191) DEFAULT NULL;

CREATE TABLE IF NOT EXISTS `data_import_batch_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `event` VARCHAR(32) NOT NULL,
  `batch_index` INT UNSIGNED DEFAULT NULL,
  `detail` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_batch_events_job` (`job_id`, `id`),
  KEY `idx_batch_events_tenant` (`tenant_id`),
  CONSTRAINT `fk_batch_events_job` FOREIGN KEY (`job_id`)
    REFERENCES `data_import_batch_jobs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
