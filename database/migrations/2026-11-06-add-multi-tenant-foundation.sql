-- =============================================================
-- SPEC 1 — Multi-tenant SaaS foundation (additive, non-destructive)
-- -------------------------------------------------------------
-- Principles:
--   * A single Muenot platform hosts multiple independent customer
--     organizations ("tenants"). Every tenant owns logically isolated
--     data. The existing Muenot internal organization is seeded as the
--     default, platform-owner tenant so nothing about the current
--     single-org install changes behaviourally.
--   * Tenant context is ALWAYS derived server-side from the authenticated
--     session (users.tenant_id), never from client input. The `slug`
--     (subdomain) is only a hint used before/at authentication.
--   * The model supports three deployment strategies so future customers
--     can be onboarded without re-architecting:
--       - shared_database    : row-level isolation via tenant_id (default)
--       - separate_schema    : one MySQL schema per tenant (db_schema)
--       - dedicated_database : an isolated database, referenced by
--                              db_connection_ref (NEVER stores secrets;
--                              the ref points at env/secret-store config).
--
-- This file documents the target schema for fresh installs. The same
-- objects are also created/altered idempotently at runtime by
-- ensureTenantSchema() in lib/tenant-service.ts, so existing databases
-- self-heal without a manual migration step.
--
-- SAFE TO RE-RUN. MySQL 8 has no reliable `ADD COLUMN IF NOT EXISTS`, so
-- column / key / FK changes go through helper procedures that check
-- information_schema first (mirrors the runtime ensure helpers).
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Table: tenants
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tenants` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(150) NOT NULL,
  `slug` VARCHAR(100) NOT NULL,
  `status` ENUM('active','suspended','inactive') NOT NULL DEFAULT 'active',
  `deployment_model` ENUM('shared_database','separate_schema','dedicated_database')
      NOT NULL DEFAULT 'shared_database',
  `plan` VARCHAR(50) NOT NULL DEFAULT 'internal',
  -- Non-secret references for non-shared deployment models. Actual
  -- credentials live in the secret store / env, keyed by these refs.
  `db_schema` VARCHAR(190) DEFAULT NULL,
  `db_connection_ref` VARCHAR(190) DEFAULT NULL,
  `settings` JSON DEFAULT NULL,
  -- 1 for the Muenot internal organization (the platform owner tenant).
  `is_platform_owner` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tenants_slug` (`slug`),
  KEY `idx_tenants_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the default platform-owner tenant (Muenot). Idempotent on slug.
INSERT INTO `tenants` (`name`, `slug`, `status`, `deployment_model`, `plan`, `is_platform_owner`)
VALUES ('Muenot', 'muenot', 'active', 'shared_database', 'internal', 1)
ON DUPLICATE KEY UPDATE `name` = `name`;

DELIMITER $$

-- Adds a column only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__mt_add_column` $$
CREATE PROCEDURE `__mt_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

-- Adds an index only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__mt_add_key` $$
CREATE PROCEDURE `__mt_add_key`(IN p_table VARCHAR(64), IN p_key VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_key
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

-- Adds a foreign key only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__mt_add_fk` $$
CREATE PROCEDURE `__mt_add_fk`(IN p_table VARCHAR(64), IN p_fk VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = p_table
      AND constraint_name = p_fk AND constraint_type = 'FOREIGN KEY'
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD CONSTRAINT `', p_fk, '` ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- Attach every existing user to a tenant. Column is nullable while we
-- backfill, then constrained below.
CALL `__mt_add_column`('users', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');

-- Backfill: existing rows belong to the default (platform-owner) tenant.
UPDATE `users`
   SET `tenant_id` = (SELECT `id` FROM `tenants` WHERE `slug` = 'muenot' LIMIT 1)
 WHERE `tenant_id` IS NULL;

-- Index + FK for fast, safe tenant scoping.
CALL `__mt_add_key`('users', 'idx_users_tenant', 'KEY `idx_users_tenant` (`tenant_id`)');
CALL `__mt_add_key`('users', 'uniq_users_tenant_email', 'UNIQUE KEY `uniq_users_tenant_email` (`tenant_id`, `email`)');
CALL `__mt_add_fk`(
  'users',
  'fk_users_tenant',
  'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE'
);

DROP PROCEDURE IF EXISTS `__mt_add_column`;
DROP PROCEDURE IF EXISTS `__mt_add_key`;
DROP PROCEDURE IF EXISTS `__mt_add_fk`;
