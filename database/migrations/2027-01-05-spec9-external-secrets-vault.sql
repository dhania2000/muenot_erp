-- -------------------------------------------------------------
-- Spec9 — External secrets vault providers (#20-21, #115-117)
-- -------------------------------------------------------------
-- Adds AWS Secrets Manager / Azure Key Vault as external vaults BEHIND the
-- existing secret abstraction, with the encrypted database vault as the
-- always-available fallback. This migration provisions the TENANT-scoped
-- integration-secret tables that hold each customer tenant's OWN integration
-- credentials (Stripe/SMTP/Twilio/…), scoped SEPARATELY from the platform
-- secrets managed in lib/secrets/store.ts.
--
-- The application self-heals these tables at runtime
-- (lib/secrets/tenant-integration-store.ts -> ensureTenantIntegrationSchema);
-- this migration makes the same schema explicit and repeatable for DBAs.
--
-- Guarantees encoded in the schema:
--   * Every row carries `tenant_id` and is filtered by it in the data layer
--     (lib/tenant-scope.ts + lib/tenant-tables.ts) so one tenant can never
--     read, resolve, rotate, or roll back another tenant's credential.
--   * Plaintext is NEVER stored: the DB fallback persists only an AES-256-GCM
--     envelope in `provider_version`; an external vault persists only its
--     opaque version handle + a provider ref.
--   * Append-only versioning powers rotation + rollback; a single active
--     version per (tenant, integration, field) is enforced in the app.
--   * A per-tenant idempotency ledger collapses retried writes to one version.
--
-- Additive and idempotent: `CREATE TABLE IF NOT EXISTS` re-runs safely.
-- -------------------------------------------------------------

-- Per-integration state: which vault it uses + last connection health/test.
CREATE TABLE IF NOT EXISTS `tenant_integration_secrets` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `integration_key` VARCHAR(64) NOT NULL,
  `vault_kind` VARCHAR(32) NOT NULL DEFAULT 'db',
  `health_state` VARCHAR(16) NOT NULL DEFAULT 'unknown',
  `last_test_detail` VARCHAR(500) DEFAULT NULL,
  `last_tested_at` TIMESTAMP NULL DEFAULT NULL,
  `last_rotated_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tenant_integration` (`tenant_id`, `integration_key`),
  KEY `idx_tis_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only encrypted version history (rotation + rollback).
CREATE TABLE IF NOT EXISTS `tenant_integration_secret_versions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `integration_key` VARCHAR(64) NOT NULL,
  `field_key` VARCHAR(64) NOT NULL,
  `version` INT UNSIGNED NOT NULL,
  `vault_kind` VARCHAR(32) NOT NULL DEFAULT 'db',
  `provider_version` LONGTEXT NOT NULL,
  `provider_ref` VARCHAR(512) DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `retired_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tis_version` (`tenant_id`, `integration_key`, `field_key`, `version`),
  KEY `idx_tisv_active` (`tenant_id`, `integration_key`, `field_key`, `is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Access + mutation audit trail (create/rotate/rollback/test/access/clear).
CREATE TABLE IF NOT EXISTS `tenant_integration_secret_audit` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `integration_key` VARCHAR(64) NOT NULL,
  `field_key` VARCHAR(64) DEFAULT NULL,
  `action` VARCHAR(20) NOT NULL,
  `actor_user_id` INT UNSIGNED DEFAULT NULL,
  `actor_email` VARCHAR(255) DEFAULT NULL,
  `detail` VARCHAR(500) DEFAULT NULL,
  `idempotency_key` VARCHAR(200) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tisa_scope` (`tenant_id`, `integration_key`),
  KEY `idx_tisa_created` (`tenant_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-tenant write idempotency ledger (retried set/rotate/rollback -> 1 version).
CREATE TABLE IF NOT EXISTS `tenant_integration_secret_idempotency` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `idem_key` VARCHAR(200) NOT NULL,
  `action` VARCHAR(20) NOT NULL,
  `integration_key` VARCHAR(64) NOT NULL,
  `field_key` VARCHAR(64) DEFAULT NULL,
  `result_version` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tis_idem` (`tenant_id`, `idem_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
