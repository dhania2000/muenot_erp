-- Spec25 — Geo, device and export protection (#213, #214, #216)
-- ---------------------------------------------------------------------------
-- Adds tenant-scoped country (geo) policies and managed-device policies +
-- enrollments. Export anomaly alerts reuse the existing `security_alerts` table
-- (Spec22) and are not created here.
--
-- All stores also self-heal these schemas at runtime (CREATE TABLE IF NOT
-- EXISTS), so this migration is the durable/portable record of the schema and
-- is safe to run repeatedly.

-- Tenant country (geo) policy: at most one row per tenant.
CREATE TABLE IF NOT EXISTS `tenant_geo_policies` (
  `tenant_id` INT UNSIGNED NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `mode` ENUM('allow','block') NOT NULL DEFAULT 'allow',
  -- ISO 3166-1 alpha-2 codes, upper-cased, as a JSON array.
  `countries` JSON DEFAULT NULL,
  -- Fail-safe posture when the location cannot be resolved (VPN / proxy / unknown IP).
  `unknown_action` ENUM('block','allow') NOT NULL DEFAULT 'block',
  -- When true, an authorized platform super admin may bypass a geo denial (audited).
  `emergency_access` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_by` INT UNSIGNED DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tenant managed-device policy: at most one row per tenant.
CREATE TABLE IF NOT EXISTS `managed_device_policies` (
  `tenant_id` INT UNSIGNED NOT NULL,
  -- When true, sign-in requires a verified device assertion for a managed device.
  `required` TINYINT(1) NOT NULL DEFAULT 0,
  -- When true, an authorized platform super admin may bypass the device requirement (audited).
  `emergency_access` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_by` INT UNSIGNED DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Enrolled managed devices. Assertions are stateless HMAC tokens bound to
-- `device_id`; revocation flips `status` so the liveness check fails.
CREATE TABLE IF NOT EXISTS `managed_device_enrollments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `device_id` VARCHAR(64) NOT NULL,
  `label` VARCHAR(190) NOT NULL,
  `status` ENUM('active','revoked') NOT NULL DEFAULT 'active',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `last_seen_at` DATETIME DEFAULT NULL,
  `revoked_by` INT UNSIGNED DEFAULT NULL,
  `revoked_at` DATETIME DEFAULT NULL,
  -- Scopes an idempotent enroll retry to a tenant so a replayed request never double-enrolls.
  `idempotency_key` VARCHAR(100) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mde_tenant_device` (`tenant_id`, `device_id`),
  UNIQUE KEY `uq_mde_tenant_idem` (`tenant_id`, `idempotency_key`),
  KEY `idx_mde_tenant_user` (`tenant_id`, `user_id`),
  KEY `idx_mde_tenant_status` (`tenant_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
