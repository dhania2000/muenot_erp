-- Conditional access policies, and the shared security audit trail
-- used by both (IP allowlist) and.
--
-- Both tables are also self-healed at runtime by their stores
-- (lib/access-policy-store.ts and lib/security-audit-store.ts, same pattern as
-- lib/session-store.ts), so a fresh database converges without running this
-- file manually and an existing one can apply it directly.

CREATE TABLE IF NOT EXISTS `access_policies` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `name` VARCHAR(160) NOT NULL,
  `priority` INT NOT NULL DEFAULT 100,
  `scope` VARCHAR(24) NOT NULL DEFAULT 'Tenant',
  `combinator` ENUM('AND','OR') NOT NULL DEFAULT 'AND',
  `effect` VARCHAR(32) NOT NULL DEFAULT 'Allow',
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `conditions` JSON DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_access_policies_tenant` (`tenant_id`),
  KEY `idx_access_policies_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `security_audit_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `category` VARCHAR(32) NOT NULL,
  `action` VARCHAR(64) NOT NULL,
  `outcome` VARCHAR(16) NOT NULL,
  `actor_user_id` INT UNSIGNED DEFAULT NULL,
  `actor_name` VARCHAR(160) DEFAULT NULL,
  `subject_email` VARCHAR(190) DEFAULT NULL,
  `ip_address` VARCHAR(64) DEFAULT NULL,
  `detail` JSON DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_security_audit_tenant` (`tenant_id`),
  KEY `idx_security_audit_category` (`category`),
  KEY `idx_security_audit_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
