-- Data Classification.
--
-- Maps a tenant's module / entity / field to one of five sensitivity levels
-- (Public, Internal, Confidential, Restricted, Highly Restricted) plus the
-- enforcement toggles that decide where the classification bites (access,
-- export, retention). The per-tenant clearance matrix (level -> minimum role
-- and auto-delete policy) is stored in company_settings under
-- `governance.classification.clearance_matrix`, not here.
--
-- Documents the schema that lib/data-classification.ts also self-heals at
-- runtime (same pattern as lib/ip-allowlist-store.ts), so a fresh database
-- converges without running this file manually and an existing one can apply
-- it directly.

CREATE TABLE IF NOT EXISTS `data_classifications` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `module` VARCHAR(96) NOT NULL,
  `entity` VARCHAR(96) NOT NULL,
  `field` VARCHAR(190) NOT NULL,
  `level` VARCHAR(24) NOT NULL DEFAULT 'Internal',
  `enforce_access` TINYINT(1) NOT NULL DEFAULT 0,
  `enforce_export` TINYINT(1) NOT NULL DEFAULT 1,
  `enforce_retention` TINYINT(1) NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_classification` (`tenant_id`, `module`, `entity`, `field`),
  KEY `idx_classification_tenant` (`tenant_id`),
  KEY `idx_classification_lookup` (`tenant_id`, `module`, `entity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
