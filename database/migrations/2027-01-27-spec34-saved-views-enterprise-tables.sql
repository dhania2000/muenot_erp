-- Spec34 (#99-108) · Enterprise UI and accessible tables.
--  * saved_views becomes a versioned migration (previously runtime-only).
--  * idempotency_key: a retried "Save view" POST with the same Idempotency-Key
--    returns the original view instead of a duplicate. Unique per tenant+user.
--  * clients list: indexes backing server-side pagination / sort.
--
-- Idempotent: ensureSavedViewSchema() self-heals the same changes, so running
-- this file twice (or after the app booted) is safe.

CREATE TABLE IF NOT EXISTS `saved_views` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `table_key` VARCHAR(96) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `visibility` ENUM('private','public','role','team') NOT NULL DEFAULT 'private',
  `owner_user_id` INT UNSIGNED DEFAULT NULL,
  `role_key` VARCHAR(64) DEFAULT NULL,
  `team_key` VARCHAR(128) DEFAULT NULL,
  `config` JSON NOT NULL,
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `idempotency_key` VARCHAR(80) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_saved_views_tenant_table` (`tenant_id`, `table_key`),
  KEY `idx_saved_views_owner` (`tenant_id`, `owner_user_id`),
  KEY `idx_saved_views_role` (`tenant_id`, `role_key`),
  KEY `idx_saved_views_team` (`tenant_id`, `team_key`),
  UNIQUE KEY `uq_saved_views_idem` (`tenant_id`, `created_by`, `idempotency_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'saved_views' AND column_name = 'idempotency_key');
SET @sql := IF(@col = 0,
  'ALTER TABLE `saved_views` ADD COLUMN `idempotency_key` VARCHAR(80) DEFAULT NULL, ADD UNIQUE KEY `uq_saved_views_idem` (`tenant_id`, `created_by`, `idempotency_key`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'clients' AND index_name = 'idx_clients_tenant_created');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `clients` ADD KEY `idx_clients_tenant_created` (`tenant_id`, `archived_at`, `created_at`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'clients' AND index_name = 'idx_clients_tenant_name');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `clients` ADD KEY `idx_clients_tenant_name` (`tenant_id`, `client_name`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
