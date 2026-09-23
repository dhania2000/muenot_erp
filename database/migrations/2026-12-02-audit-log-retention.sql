-- SPEC 68 — Audit log retention.
--
-- Builds on SPEC 67's immutable, append-only `audit_log_entries`
-- (lib/audit-log-store.ts). These tables are also self-healed at runtime by
-- lib/audit-retention.ts (same pattern as lib/audit-log-store.ts), so a fresh
-- database converges without running this file manually and an existing one can
-- apply it directly.
--
-- Scope convention for the aux tables: `tenant_id` holds a real tenant id for a
-- tenant's own audit rows, and the reserved value 0 for the platform-wide rows
-- stored in audit_log_entries with tenant_id IS NULL.

-- SPEC 67 base table. Normally created by lib/audit-log-store.ts's runtime
-- self-heal, but included here (IF NOT EXISTS, so it's a no-op where it already
-- exists) so this file can be imported directly into a database that has not
-- yet run SPEC 67 — otherwise the `audit_log_no_delete` trigger below fails with
-- "Table 'audit_log_entries' doesn't exist" (#1146). Keep in sync with
-- lib/audit-log-store.ts.
CREATE TABLE IF NOT EXISTS `audit_log_entries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id` VARCHAR(64) DEFAULT NULL,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `actor_user_id` INT UNSIGNED DEFAULT NULL,
  `actor_name` VARCHAR(160) DEFAULT NULL,
  `actor_email` VARCHAR(190) DEFAULT NULL,
  `actor_role` VARCHAR(32) DEFAULT NULL,
  `session_id` VARCHAR(64) DEFAULT NULL,
  `ip_address` VARCHAR(64) DEFAULT NULL,
  `user_agent` VARCHAR(512) DEFAULT NULL,
  `action` VARCHAR(96) NOT NULL,
  `entity_type` VARCHAR(96) DEFAULT NULL,
  `entity_id` VARCHAR(128) DEFAULT NULL,
  `entity_label` VARCHAR(255) DEFAULT NULL,
  `result` VARCHAR(16) NOT NULL DEFAULT 'success',
  `before_data` JSON DEFAULT NULL,
  `after_data` JSON DEFAULT NULL,
  `metadata` JSON DEFAULT NULL,
  `integrity_hash` CHAR(64) DEFAULT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_audit_tenant` (`tenant_id`),
  KEY `idx_audit_actor` (`actor_user_id`),
  KEY `idx_audit_action` (`action`),
  KEY `idx_audit_entity` (`entity_type`, `entity_id`),
  KEY `idx_audit_created` (`created_at`),
  KEY `idx_audit_request` (`request_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Platform-wide default + compliance floor (single row, id = 1).
CREATE TABLE IF NOT EXISTS `audit_retention_platform_policy` (
  `id` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `default_retention_days` INT UNSIGNED NOT NULL DEFAULT 2555,
  `min_retention_days` INT UNSIGNED NOT NULL DEFAULT 365,
  `archive_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `purge_after_archive` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_by` BIGINT UNSIGNED DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-tenant override (retain longer than the platform default, toggle archive
-- / purge). Retention is clamped to the platform floor in the application.
CREATE TABLE IF NOT EXISTS `audit_retention_tenant_policies` (
  `tenant_id` INT UNSIGNED NOT NULL,
  `retention_days` INT UNSIGNED NOT NULL,
  `archive_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `purge_after_archive` TINYINT(1) NOT NULL DEFAULT 0,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `last_run_at` DATETIME DEFAULT NULL,
  `updated_by` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Legal holds: freeze matching entries from purge until released.
CREATE TABLE IF NOT EXISTS `audit_retention_legal_holds` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(200) NOT NULL,
  `reason` TEXT DEFAULT NULL,
  `filter_action` VARCHAR(96) DEFAULT NULL,
  `filter_entity_type` VARCHAR(96) DEFAULT NULL,
  `filter_actor_user_id` INT UNSIGNED DEFAULT NULL,
  `from_date` DATETIME DEFAULT NULL,
  `to_date` DATETIME DEFAULT NULL,
  `status` VARCHAR(12) NOT NULL DEFAULT 'active',
  `created_by` BIGINT UNSIGNED DEFAULT NULL,
  `created_by_name` VARCHAR(160) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `released_by` BIGINT UNSIGNED DEFAULT NULL,
  `released_by_name` VARCHAR(160) DEFAULT NULL,
  `released_at` DATETIME DEFAULT NULL,
  `release_reason` VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_arlh_tenant_status` (`tenant_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Immutable, hash-chained archive of aged audit entries. gzip-sealed payload
-- lives in `payload`; `content_hash` seals it and `prev_hash` chains batches so
-- tampering with any earlier batch is detectable.
CREATE TABLE IF NOT EXISTS `audit_log_archive_batches` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `batch_uuid` CHAR(36) NOT NULL,
  `from_entry_id` BIGINT UNSIGNED NOT NULL,
  `to_entry_id` BIGINT UNSIGNED NOT NULL,
  `from_ts` DATETIME DEFAULT NULL,
  `to_ts` DATETIME DEFAULT NULL,
  `entry_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `payload` LONGBLOB DEFAULT NULL,
  `payload_bytes` INT UNSIGNED NOT NULL DEFAULT 0,
  `content_hash` CHAR(64) NOT NULL,
  `prev_hash` CHAR(64) DEFAULT NULL,
  `blob_url` VARCHAR(1024) DEFAULT NULL,
  `purged` TINYINT(1) NOT NULL DEFAULT 0,
  `purged_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_by` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_arb_uuid` (`batch_uuid`),
  KEY `idx_arb_tenant` (`tenant_id`, `to_entry_id`),
  KEY `idx_arb_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the platform policy row with the conservative defaults.
INSERT INTO `audit_retention_platform_policy`
  (`id`, `default_retention_days`, `min_retention_days`, `archive_enabled`, `purge_after_archive`)
VALUES (1, 2555, 365, 1, 0)
ON DUPLICATE KEY UPDATE `id` = `id`;

-- Immutability guards on the archive table (append-only).
DROP TRIGGER IF EXISTS `audit_archive_no_update`;
CREATE TRIGGER `audit_archive_no_update` BEFORE UPDATE ON `audit_log_archive_batches`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log_archive_batches is append-only';

DROP TRIGGER IF EXISTS `audit_archive_no_delete`;
CREATE TRIGGER `audit_archive_no_delete` BEFORE DELETE ON `audit_log_archive_batches`
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log_archive_batches is append-only';

-- Upgrade SPEC 67's delete guard so the ONLY permitted deletion path is the
-- authorized retention purge (which sets @audit_retention_purge = 1 on its own
-- connection first). UPDATEs stay rejected unconditionally.
--
-- NOTE: this trigger has a compound BEGIN ... END body, so its inner statements
-- are terminated with `;`. When applying this file with a client that splits on
-- `;` (phpMyAdmin, the mysql CLI), the DELIMITER switch below is REQUIRED so the
-- whole CREATE TRIGGER is sent as one statement instead of being cut off at the
-- first inner semicolon. Runtime self-heal (lib/audit-log-store.ts) sends the
-- statement whole through the driver and needs no delimiter change.
DELIMITER $$

DROP TRIGGER IF EXISTS `audit_log_no_delete`$$

CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log_entries`
  FOR EACH ROW
  BEGIN
    IF @audit_retention_purge IS NULL OR @audit_retention_purge <> 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log_entries is append-only; deletion is only permitted via authorized retention purge';
    END IF;
  END$$

DELIMITER ;
