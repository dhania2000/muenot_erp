-- Spec3 — Dedicated database & region routing (#46-48, #162)
-- ---------------------------------------------------------------------------
-- Region residency columns on the tenant directory + the per-tenant database
-- routing/provisioning registry and its append-only audit ledger.
--
-- This mirrors the self-healing schema in lib/tenant-db/store.ts so fresh
-- installs get the tables directly; existing installs converge at runtime.
-- Safe to run more than once.

-- Region residency anchors + placement (data may only move within a group).
ALTER TABLE `tenants` ADD COLUMN IF NOT EXISTS `data_region`    VARCHAR(40) DEFAULT NULL;
ALTER TABLE `tenants` ADD COLUMN IF NOT EXISTS `db_region`      VARCHAR(40) DEFAULT NULL;
ALTER TABLE `tenants` ADD COLUMN IF NOT EXISTS `storage_region` VARCHAR(40) DEFAULT NULL;
ALTER TABLE `tenants` ADD COLUMN IF NOT EXISTS `backup_region`  VARCHAR(40) DEFAULT NULL;

-- Per-tenant database routing + independent provisioning lifecycle.
CREATE TABLE IF NOT EXISTS `tenant_db_connections` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `deployment_model` ENUM('shared_database','separate_schema','dedicated_database')
      NOT NULL DEFAULT 'shared_database',
  `db_schema` VARCHAR(64) DEFAULT NULL,
  -- A REFERENCE to a deployment-managed secret (env var name) that holds the
  -- dedicated DSN. Credentials themselves are never stored in the database.
  `connection_ref` VARCHAR(190) DEFAULT NULL,
  `region` VARCHAR(40) DEFAULT NULL,
  `status` ENUM('unprovisioned','provisioning','active','migrating','failed')
      NOT NULL DEFAULT 'unprovisioned',
  `schema_version` INT UNSIGNED NOT NULL DEFAULT 0,
  `health_status` ENUM('unknown','healthy','unhealthy') NOT NULL DEFAULT 'unknown',
  `health_detail` VARCHAR(500) DEFAULT NULL,
  `last_health_check_at` DATETIME DEFAULT NULL,
  `last_migrated_at` DATETIME DEFAULT NULL,
  `last_backup_at` DATETIME DEFAULT NULL,
  `last_backup_ref` VARCHAR(128) DEFAULT NULL,
  `error_message` VARCHAR(1000) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tenant_db` (`tenant_id`),
  CONSTRAINT `fk_tenant_db_tenant` FOREIGN KEY (`tenant_id`)
    REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only audit ledger. The unique (tenant, action, key) index doubles as
-- the idempotency guard for provision/migrate/backup actions.
CREATE TABLE IF NOT EXISTS `tenant_db_audit` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `action` VARCHAR(48) NOT NULL,
  `detail` JSON DEFAULT NULL,
  `idempotency_key` VARCHAR(128) DEFAULT NULL,
  `actor_user_id` INT UNSIGNED DEFAULT NULL,
  `actor_email` VARCHAR(190) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tdb_audit_tenant` (`tenant_id`, `created_at`),
  UNIQUE KEY `uniq_tdb_idem` (`tenant_id`, `action`, `idempotency_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
