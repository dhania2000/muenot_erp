-- ============================================================================
-- SPEC 39 — Canonical tenant configuration (additive and idempotent)
--
-- `company_settings` remains an inherited legacy/platform baseline. Runtime
-- writes use `tenant_settings`, so every customer can override the same key
-- without changing another tenant's configuration.
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `tenant_settings` (
  `tenant_id` INT UNSIGNED NOT NULL,
  `skey` VARCHAR(160) NOT NULL,
  `svalue` LONGTEXT DEFAULT NULL,
  `value_type` VARCHAR(32) NOT NULL DEFAULT 'text',
  `is_secret` TINYINT(1) NOT NULL DEFAULT 0,
  `source` ENUM('override','migrated') NOT NULL DEFAULT 'override',
  `updated_by` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`, `skey`),
  KEY `idx_tenant_settings_key` (`skey`),
  CONSTRAINT `fk_tenant_settings_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `tenant_settings_audit` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `setting_key` VARCHAR(160) NOT NULL,
  `action` ENUM('set','clear') NOT NULL,
  `detail` JSON DEFAULT NULL,
  `actor_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tenant_settings_audit_tenant` (`tenant_id`, `created_at`),
  CONSTRAINT `fk_tenant_settings_audit_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
