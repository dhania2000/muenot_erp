-- SPEC 15 — Integration marketplace (#88-89)
-- ---------------------------------------------------------------------------
-- Installable connector catalog (Tally, Zoho, Microsoft, Google, Slack). Each
-- connector is backed by a REVIEWED server adapter (lib/marketplace/adapters.ts)
-- and a COMMON manifest (lib/marketplace/connectors.ts) describing its scopes,
-- credentials and events. These tables persist a tenant's install lifecycle,
-- its encrypted-at-rest credentials with active/revoked state, a lifecycle
-- audit trail, and a write idempotency ledger.
--
-- Every table is tenant-scoped (registered in lib/tenant-tables.ts). All reads
-- and writes go through lib/tenant-scope helpers, so one tenant can never see,
-- resolve, reconnect or disconnect another tenant's connector. The store
-- self-heals these tables at runtime (CREATE TABLE IF NOT EXISTS); this
-- migration is the authoritative schema of record.

-- Per-connector install + health state (one row per tenant + connector).
CREATE TABLE IF NOT EXISTS `tenant_connector_installations` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `connector_key` VARCHAR(64) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'not_installed',
  `granted_scopes` TEXT DEFAULT NULL,
  `health_state` VARCHAR(16) NOT NULL DEFAULT 'unknown',
  `last_error` VARCHAR(500) DEFAULT NULL,
  `installed_by` INT UNSIGNED DEFAULT NULL,
  `installed_at` TIMESTAMP NULL DEFAULT NULL,
  `last_connected_at` TIMESTAMP NULL DEFAULT NULL,
  `last_health_at` TIMESTAMP NULL DEFAULT NULL,
  `disconnected_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tenant_connector` (`tenant_id`, `connector_key`),
  KEY `idx_tci_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Encrypted-at-rest connector credentials. Append-only: a rotation inserts a
-- new active row and retires the prior one; a disconnect revokes all active
-- rows (is_active = 0, revoked_at set). Ciphertext is an AES-256-GCM envelope
-- produced by lib/secrets/crypto.ts — plaintext never lands in a column.
CREATE TABLE IF NOT EXISTS `tenant_connector_credentials` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `connector_key` VARCHAR(64) NOT NULL,
  `field_key` VARCHAR(64) NOT NULL,
  `ciphertext` LONGTEXT NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revoked_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_tcc_active` (`tenant_id`, `connector_key`, `field_key`, `is_active`),
  KEY `idx_tcc_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Lifecycle audit trail (install / reconnect / disconnect / health / access).
CREATE TABLE IF NOT EXISTS `tenant_connector_audit` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `connector_key` VARCHAR(64) NOT NULL,
  `action` VARCHAR(24) NOT NULL,
  `actor_user_id` INT UNSIGNED DEFAULT NULL,
  `actor_email` VARCHAR(255) DEFAULT NULL,
  `detail` VARCHAR(500) DEFAULT NULL,
  `idempotency_key` VARCHAR(200) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tca_scope` (`tenant_id`, `connector_key`),
  KEY `idx_tca_created` (`tenant_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Write idempotency ledger: a client Idempotency-Key collapses retries of the
-- same install / reconnect / disconnect to a single effect.
CREATE TABLE IF NOT EXISTS `tenant_connector_idempotency` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `idem_key` VARCHAR(200) NOT NULL,
  `action` VARCHAR(24) NOT NULL,
  `connector_key` VARCHAR(64) NOT NULL,
  `result_status` VARCHAR(16) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tc_idem` (`tenant_id`, `idem_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
