-- Temporary access & Break-glass (emergency) access.
--
-- A single time-boxed access-grant table backing both features. It is also
-- self-healed at runtime by lib/temporary-access-store.ts (same pattern as
-- lib/session-store.ts / lib/access-policy-store.ts), so a fresh database
-- converges without running this file manually and an existing one can apply
-- it directly.

CREATE TABLE IF NOT EXISTS `temporary_access_grants` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `kind` ENUM('temporary','break_glass') NOT NULL DEFAULT 'temporary',
  `status` ENUM('pending','active','expired','revoked','rejected') NOT NULL DEFAULT 'pending',
  `user_id` INT UNSIGNED NOT NULL,
  `user_name` VARCHAR(190) DEFAULT NULL,
  `user_email` VARCHAR(190) DEFAULT NULL,
  `granted_role` VARCHAR(24) DEFAULT NULL,
  `previous_role` VARCHAR(24) DEFAULT NULL,
  `scope` VARCHAR(300) NOT NULL,
  `reason` VARCHAR(1000) NOT NULL,
  `approver_user_id` INT UNSIGNED DEFAULT NULL,
  `approver_name` VARCHAR(190) DEFAULT NULL,
  `requested_by` INT UNSIGNED NOT NULL,
  `requested_by_name` VARCHAR(190) DEFAULT NULL,
  `notify_security` TINYINT(1) NOT NULL DEFAULT 0,
  `start_at` DATETIME NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `activated_at` DATETIME DEFAULT NULL,
  `ended_at` DATETIME DEFAULT NULL,
  `end_reason` VARCHAR(300) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tag_tenant` (`tenant_id`),
  KEY `idx_tag_user` (`user_id`),
  KEY `idx_tag_kind` (`kind`),
  KEY `idx_tag_status` (`status`),
  KEY `idx_tag_due` (`status`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
