-- =============================================================
-- Platform vs Tenant role separation (additive, non-destructive)
-- -------------------------------------------------------------
-- Introduces two ORTHOGONAL role axes on `users` plus an audit trail, so that
-- operating the Muenot PLATFORM and operating a single TENANT's data are
-- distinct, separately-granted authorities that cannot be mistaken for each
-- other (see lib/role-model.ts for the boundary rules):
--
--   users.platform_role  ENUM('none','platform_staff','platform_super_admin')
--   users.tenant_role    ENUM('employee','module_admin','tenant_admin','tenant_owner')
--
-- The legacy `users.role` (admin|employee) is preserved untouched so every
-- existing feature/permission-matrix check keeps working; `tenant_role` is
-- backfilled from it (admin -> tenant_admin, else employee).
--
-- `platform_admin_audit` records every platform/tenant role change and every
-- tenant impersonation start/stop for the penetration-style review (Phase 4).
--
-- SAFE TO RE-RUN. The same objects are also created idempotently at runtime by
-- ensurePlatformRoleSchema() in lib/platform-roles.ts, so existing databases
-- self-heal without a manual migration step (matching the project's other
-- lib/*-ensure helpers). MySQL 8 has no reliable ADD ... IF NOT EXISTS, so
-- column changes go through a helper procedure that checks information_schema.
-- =============================================================

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `__pr_add_column` $$
CREATE PROCEDURE `__pr_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__pr_add_key` $$
CREATE PROCEDURE `__pr_add_key`(IN p_table VARCHAR(64), IN p_key VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (SELECT 1 FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_key) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- Two orthogonal role axes on users.
CALL `__pr_add_column`('users', 'platform_role',
  "`platform_role` ENUM('none','platform_staff','platform_super_admin') NOT NULL DEFAULT 'none' AFTER `role`");
CALL `__pr_add_column`('users', 'tenant_role',
  "`tenant_role` ENUM('employee','module_admin','tenant_admin','tenant_owner') NOT NULL DEFAULT 'employee' AFTER `platform_role`");

CALL `__pr_add_key`('users', 'idx_users_platform_role', 'KEY `idx_users_platform_role` (`platform_role`)');
CALL `__pr_add_key`('users', 'idx_users_tenant_role', 'KEY `idx_users_tenant_role` (`tenant_role`)');

-- Backfill tenant_role from the legacy coarse role. Admins become tenant_admin;
-- everyone else stays a normal employee (module-admin and owner are explicit
-- opt-in distinctions granted later through the console).
UPDATE `users` SET `tenant_role` = 'tenant_admin' WHERE `role` = 'admin'  AND `tenant_role` = 'employee';
UPDATE `users` SET `tenant_role` = 'employee'     WHERE `role` = 'employee' AND `tenant_role` = 'employee';

-- Bootstrap a single platform operator so the platform console is reachable
-- without hand-editing the DB: the earliest-created admin in the platform-owner
-- tenant (Muenot) becomes platform_super_admin, but ONLY if no platform
-- super admin exists yet. This never downgrades or overrides an explicit grant.
UPDATE `users`
   SET `platform_role` = 'platform_super_admin'
 WHERE `id` = (
   SELECT id FROM (
     SELECT u.id
       FROM `users` u
       JOIN `tenants` t ON t.id = u.tenant_id
      WHERE t.is_platform_owner = 1 AND u.role = 'admin' AND u.status = 'active'
      ORDER BY u.id ASC
      LIMIT 1
   ) AS pick
 )
 AND NOT EXISTS (
   SELECT 1 FROM (SELECT * FROM `users`) u2 WHERE u2.platform_role = 'platform_super_admin'
 );

-- Audit trail for role changes and impersonation (penetration-review evidence).
CREATE TABLE IF NOT EXISTS `platform_admin_audit` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `actor_user_id` INT UNSIGNED NOT NULL,
  `actor_email` VARCHAR(190) DEFAULT NULL,
  `action` VARCHAR(64) NOT NULL,
  `target_user_id` INT UNSIGNED DEFAULT NULL,
  `target_tenant_id` INT UNSIGNED DEFAULT NULL,
  `detail` JSON DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_paa_actor` (`actor_user_id`),
  KEY `idx_paa_action` (`action`),
  KEY `idx_paa_target_tenant` (`target_tenant_id`),
  KEY `idx_paa_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS `__pr_add_column`;
DROP PROCEDURE IF EXISTS `__pr_add_key`;
