-- =============================================================
-- — API Key platform + Webhook delivery engine.
-- Self-created at runtime by lib/api-keys-store.ts / lib/webhooks-store.ts
-- (ensureApiKeysSchema / ensureWebhooksSchema). This file documents the
-- shape for manual phpMyAdmin imports on installs that prefer to run
-- migrations up front instead of relying on the runtime self-heal.
-- =============================================================

CREATE TABLE IF NOT EXISTS `api_keys` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `key_prefix` VARCHAR(16) NOT NULL,
  `key_hash` VARCHAR(64) NOT NULL,
  `scopes` VARCHAR(255) NOT NULL DEFAULT '',
  `status` ENUM('active','revoked') NOT NULL DEFAULT 'active',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` DATETIME DEFAULT NULL,
  `expires_at` DATETIME DEFAULT NULL,
  `revoked_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_api_keys_hash` (`key_hash`),
  KEY `idx_api_keys_tenant` (`tenant_id`),
  KEY `idx_api_keys_prefix` (`key_prefix`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `webhook_endpoints` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `events` VARCHAR(500) NOT NULL DEFAULT '',
  `secret_encrypted` TEXT DEFAULT NULL,
  `status` ENUM('active','disabled') NOT NULL DEFAULT 'active',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_delivery_at` DATETIME DEFAULT NULL,
  `last_delivery_ok` TINYINT(1) DEFAULT NULL,
  `failure_count` INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_webhook_endpoints_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `webhook_deliveries` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `endpoint_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED NOT NULL,
  `event_type` VARCHAR(80) NOT NULL,
  `payload` MEDIUMTEXT NOT NULL,
  `status` ENUM('pending','success','failed') NOT NULL DEFAULT 'pending',
  `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `response_code` INT DEFAULT NULL,
  `response_body` VARCHAR(500) DEFAULT NULL,
  `next_retry_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `delivered_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_webhook_deliveries_endpoint` (`endpoint_id`),
  KEY `idx_webhook_deliveries_tenant` (`tenant_id`),
  KEY `idx_webhook_deliveries_retry` (`status`, `next_retry_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
