-- Spec22 · Login protection and security alerts (#37, #215)
-- Tenant-scoped correlation + alerting layer built ON TOP of the existing
-- login-protection primitives (password-policy lockout, session revocation,
-- security audit, notification engine). See lib/security-alerts-store.ts.
--
-- Idempotent: the application also self-heals this schema via
-- ensureSecurityAlertsSchema(), so this migration mirrors that DDL exactly.

CREATE TABLE IF NOT EXISTS `security_alerts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `alert_type` VARCHAR(48) NOT NULL,
  `severity` ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',
  `status` ENUM('open','acknowledged','resolved') NOT NULL DEFAULT 'open',
  `dedupe_key` VARCHAR(190) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `detail` JSON DEFAULT NULL,
  `subject_user_id` INT UNSIGNED DEFAULT NULL,
  `subject_label` VARCHAR(190) DEFAULT NULL,
  `source_ip` VARCHAR(64) DEFAULT NULL,
  `occurrence_count` INT UNSIGNED NOT NULL DEFAULT 1,
  `notified` TINYINT(1) NOT NULL DEFAULT 0,
  `first_seen` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `acknowledged_by` INT UNSIGNED DEFAULT NULL,
  `acknowledged_at` DATETIME DEFAULT NULL,
  `resolved_by` INT UNSIGNED DEFAULT NULL,
  `resolved_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sa_tenant_status` (`tenant_id`, `status`),
  KEY `idx_sa_dedupe` (`tenant_id`, `dedupe_key`, `status`),
  KEY `idx_sa_type` (`tenant_id`, `alert_type`),
  KEY `idx_sa_last_seen` (`last_seen`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
