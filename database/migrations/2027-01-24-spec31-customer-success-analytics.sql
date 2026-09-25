-- Spec31 (#174-175) — Customer success & product analytics.
-- Mirrors ensureCustomerSuccessSchema() in lib/customer-success/store.ts (the
-- store also self-heals at runtime). Health signals are READ from existing
-- tables (system_logs, platform_background_jobs, tenant_subscriptions,
-- platform_invoices, platform_support_tickets, users); only the analytics
-- stream, its rollup, settings, opt-outs and snapshots are new.

-- Raw, pseudonymous usage events. actor_hash is an HMAC of tenant+user; no
-- free text is ever stored. Purged per tenant retention_days.
CREATE TABLE IF NOT EXISTS `cs_usage_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `actor_hash` CHAR(32) NOT NULL,
  `module` VARCHAR(40) NOT NULL,
  `feature` VARCHAR(64) NOT NULL,
  `action` VARCHAR(16) NOT NULL,
  `dedup_key` CHAR(64) NOT NULL,
  `occurred_at` DATETIME NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_cs_event_dedup` (`tenant_id`, `dedup_key`),
  KEY `idx_cs_event_tenant_time` (`tenant_id`, `occurred_at`),
  KEY `idx_cs_event_actor` (`tenant_id`, `actor_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Anonymous daily counts (no actor). Kept 730 days for trends.
CREATE TABLE IF NOT EXISTS `cs_usage_daily` (
  `tenant_id` INT UNSIGNED NOT NULL,
  `day` DATE NOT NULL,
  `module` VARCHAR(40) NOT NULL,
  `feature` VARCHAR(64) NOT NULL,
  `action` VARCHAR(16) NOT NULL,
  `events` INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`tenant_id`, `day`, `module`, `feature`, `action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `cs_tenant_settings` (
  `tenant_id` INT UNSIGNED NOT NULL,
  `analytics_opt_out` TINYINT(1) NOT NULL DEFAULT 0,
  `retention_days` SMALLINT UNSIGNED NOT NULL DEFAULT 180,
  `updated_by` INT UNSIGNED DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `cs_user_opt_outs` (
  `tenant_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One explainable snapshot per tenant per day (upserted => idempotent).
CREATE TABLE IF NOT EXISTS `cs_health_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `snapshot_date` DATE NOT NULL,
  `score` TINYINT UNSIGNED NOT NULL,
  `band` VARCHAR(12) NOT NULL,
  `risk_count` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `factors` JSON NOT NULL,
  `risks` JSON NOT NULL,
  `signals` JSON NOT NULL,
  `computed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_cs_snapshot_day` (`tenant_id`, `snapshot_date`),
  KEY `idx_cs_snapshot_band` (`snapshot_date`, `band`, `score`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
