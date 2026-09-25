-- Spec32 (#176-179) — First-run onboarding, help & release notes.
-- ---------------------------------------------------------------------------
-- Three small, tenant-scoped subsystems. Every row that belongs to a tenant
-- carries an explicit tenant_id derived server-side from the session (never
-- from a request body). The app also self-heals these tables at runtime via
-- the ensure*Schema() helpers, so this migration is idempotent documentation
-- of the same DDL.

-- Resumable first-login setup checklist. One row per tenant holds the manual
-- overrides (done / skipped) and the dismissed flag; live completion of each
-- step is recalculated from real signals at read time, never stored here.
CREATE TABLE IF NOT EXISTS `onboarding_checklist` (
  `tenant_id` INT UNSIGNED NOT NULL,
  `dismissed` TINYINT(1) NOT NULL DEFAULT 0,
  `overrides` JSON DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `updated_by` INT UNSIGNED DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Versioned product updates / release notes. Authored by platform operators.
-- Audience targeting is evaluated server-side against the viewer's tenant,
-- role and plan so a tenant-scoped update is only ever shown to its tenants.
CREATE TABLE IF NOT EXISTS `product_updates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `version` VARCHAR(40) NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `body` TEXT NOT NULL,
  `category` VARCHAR(20) NOT NULL DEFAULT 'announcement',
  `audience_type` VARCHAR(12) NOT NULL DEFAULT 'all',
  `audience_config` JSON DEFAULT NULL,
  `status` VARCHAR(12) NOT NULL DEFAULT 'draft',
  `published_at` DATETIME DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_by_name` VARCHAR(160) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pu_status_pub` (`status`, `published_at`),
  KEY `idx_pu_version` (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-user read state for product updates. tenant_id is denormalized so read
-- state stays scoped to the acting tenant and cross-tenant reads are impossible.
CREATE TABLE IF NOT EXISTS `product_update_reads` (
  `update_id` BIGINT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `read_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`update_id`, `user_id`),
  KEY `idx_pur_user` (`tenant_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
