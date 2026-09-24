-- ===========================================================================
-- Multi-organization membership (Spec2 — Organization onboarding & hierarchy)
-- ---------------------------------------------------------------------------
-- Lets a single user belong to MANY organizations (tenants), each with its own
-- tenant_role, so consultants / group-finance / cross-org staff can switch the
-- ACTIVE organization for their session. The user's HOME tenant on
-- users.tenant_id remains authoritative and is backfilled here as the user's
-- primary membership.
--
-- This is a CROSS-tenant mapping table (user -> tenants); it is deliberately
-- NOT tenant-owned. Every read is constrained by the authenticated user_id and
-- tenant switching is validated against it server-side (lib/tenant-membership.ts).
--
-- Mirrored by the runtime self-heal in lib/tenant-membership.ts, so existing
-- installs converge without running this file manually.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS `user_tenant_memberships` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED NOT NULL,
  `tenant_role` ENUM('employee','module_admin','tenant_admin','tenant_owner') NOT NULL DEFAULT 'employee',
  `is_primary` TINYINT(1) NOT NULL DEFAULT 0,
  `status` ENUM('active','suspended') NOT NULL DEFAULT 'active',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_membership_user_tenant` (`user_id`, `tenant_id`),
  KEY `idx_membership_user` (`user_id`),
  KEY `idx_membership_tenant` (`tenant_id`),
  KEY `idx_membership_user_status` (`user_id`, `status`),
  CONSTRAINT `fk_membership_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_membership_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill each existing user's home tenant as their primary membership.
-- Idempotent on the unique (user_id, tenant_id) key.
INSERT INTO `user_tenant_memberships` (`user_id`, `tenant_id`, `tenant_role`, `is_primary`, `status`)
  SELECT u.id,
         COALESCE(u.tenant_id, (SELECT id FROM `tenants` WHERE slug = 'muenot' LIMIT 1)),
         COALESCE(NULLIF(u.tenant_role, ''), IF(u.role = 'admin', 'tenant_admin', 'employee')),
         1,
         'active'
    FROM `users` u
   WHERE COALESCE(u.tenant_id, (SELECT id FROM `tenants` WHERE slug = 'muenot' LIMIT 1)) IS NOT NULL
ON DUPLICATE KEY UPDATE `is_primary` = `user_tenant_memberships`.`is_primary`;
