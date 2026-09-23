-- Enterprise Dashboard Engine
-- Configurable, saved dashboards. Scopes: personal / role / tenant.
-- The app also self-heals this table at runtime (lib/dashboards/store.ts),
-- so applying this migration is optional but recommended for fresh installs.

CREATE TABLE IF NOT EXISTS `dashboards` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `scope` ENUM('personal','role','tenant') NOT NULL DEFAULT 'personal',
  `owner_user_id` INT UNSIGNED DEFAULT NULL,
  `role_key` VARCHAR(64) DEFAULT NULL,
  `config` JSON NOT NULL,
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_dashboards_tenant_scope` (`tenant_id`, `scope`),
  KEY `idx_dashboards_owner` (`tenant_id`, `owner_user_id`),
  KEY `idx_dashboards_role` (`tenant_id`, `role_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
