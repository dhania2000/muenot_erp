-- =============================================================================
-- SPEC 97 — Custom Report Builder
-- -----------------------------------------------------------------------------
-- Lets authorized users save reports built over a whitelisted data source, with
-- columns, filters, grouping, sorting, calculations and date ranges captured in
-- the `definition` JSON. The safe query abstraction (lib/reports/query-builder)
-- always compiles a tenant-scoped query; report access is enforced centrally
-- by SPEC 99 (lib/reports/authorization.ts).
--
-- The application self-heals this table at runtime (lib/reports/store.ts); this
-- migration is the canonical, idempotent record of that schema.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `custom_reports` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `name` VARCHAR(190) NOT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  `source_key` VARCHAR(120) NOT NULL,
  `definition` JSON NOT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_custom_report_tenant` (`tenant_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
