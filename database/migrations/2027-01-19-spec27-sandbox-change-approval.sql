-- Spec27 — Production sandbox & configuration change approval (#123-124)
-- ---------------------------------------------------------------------------
-- Enterprise tenants get a separate sandbox environment with its own
-- connection set, a sanitized production→sandbox copy, and a review → approval
-- → promotion pipeline for configuration changes. All three tables are
-- tenant-scoped (tenant_id + FK to tenants) so a tenant can never see or
-- promote another tenant's changes. The runtime store self-heals the same
-- schema for existing installs; this migration is for fresh installs.

CREATE TABLE IF NOT EXISTS `sandbox_environments` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `status` ENUM('inactive','active') NOT NULL DEFAULT 'inactive',
  `db_schema` VARCHAR(64) DEFAULT NULL,
  `connection_ref` VARCHAR(190) DEFAULT NULL,
  `region` VARCHAR(40) DEFAULT NULL,
  `sanitized_config` JSON DEFAULT NULL,
  `last_copy_at` DATETIME DEFAULT NULL,
  `last_copy_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_sandbox_tenant` (`tenant_id`),
  CONSTRAINT `fk_sandbox_env_tenant` FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sandbox_change_requests` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `module_key` VARCHAR(64) NOT NULL DEFAULT 'platform.config_change',
  `status` ENUM('draft','pending_approval','approved','rejected','promoted','rolled_back','cancelled')
      NOT NULL DEFAULT 'draft',
  `deploy_status` ENUM('not_deployed','deploying','deployed','failed','rolled_back')
      NOT NULL DEFAULT 'not_deployed',
  -- Proposed non-secret values are stored raw; the diff (with secrets redacted)
  -- is stored for display. Rollback snapshot captures pre-promotion prod values.
  `proposed` JSON NOT NULL,
  `diff` JSON NOT NULL,
  `rollback_snapshot` JSON DEFAULT NULL,
  `baseline_hash` VARCHAR(32) DEFAULT NULL,
  `approved_baseline_hash` VARCHAR(32) DEFAULT NULL,
  `approval_request_id` INT UNSIGNED DEFAULT NULL,
  `approval_status` VARCHAR(20) DEFAULT NULL,
  `approver_user_id` INT UNSIGNED DEFAULT NULL,
  `approver_name` VARCHAR(190) DEFAULT NULL,
  `decided_at` DATETIME DEFAULT NULL,
  `promoted_at` DATETIME DEFAULT NULL,
  `promoted_by` INT UNSIGNED DEFAULT NULL,
  `rolled_back_at` DATETIME DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_by_name` VARCHAR(190) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sandbox_change_tenant` (`tenant_id`, `created_at`),
  KEY `idx_sandbox_change_status` (`tenant_id`, `status`),
  CONSTRAINT `fk_sandbox_change_tenant` FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sandbox_change_audit` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `change_id` INT UNSIGNED DEFAULT NULL,
  `action` VARCHAR(48) NOT NULL,
  `detail` JSON DEFAULT NULL,
  `idempotency_key` VARCHAR(128) DEFAULT NULL,
  `actor_user_id` INT UNSIGNED DEFAULT NULL,
  `actor_email` VARCHAR(190) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sandbox_audit_tenant` (`tenant_id`, `created_at`),
  UNIQUE KEY `uniq_sandbox_idem` (`tenant_id`, `action`, `idempotency_key`),
  CONSTRAINT `fk_sandbox_audit_tenant` FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
