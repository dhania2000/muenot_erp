-- Legal Hold.
--
-- A legal hold is a named, auditable directive that PROTECTS a set of records
-- or files from destruction while a matter (litigation, audit, regulatory
-- inquiry) is open. While a hold is ACTIVE the covered data is never removed by
-- an automated retention job — the record-retention engine
-- (lib/retention-engine.ts) and the storage-retention sweep
-- (lib/storage/retention.ts) both consult these tables before deleting.
--
-- A hold owns one or more ITEMS, each declaring WHAT it covers via a scope:
--   module | record_type | record | criteria | file
--
-- Documents the schema that lib/legal-hold-store.ts also self-heals at runtime
-- (same pattern as lib/retention-engine.ts), so a fresh database converges
-- without running this file manually and an existing one can apply it directly.

CREATE TABLE IF NOT EXISTS `legal_holds` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `name` VARCHAR(200) NOT NULL,
  `reason` VARCHAR(1000) DEFAULT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `released_by` INT UNSIGNED DEFAULT NULL,
  `released_reason` VARCHAR(1000) DEFAULT NULL,
  `released_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_legal_hold_tenant` (`tenant_id`),
  KEY `idx_legal_hold_status` (`tenant_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `legal_hold_items` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `hold_id` INT UNSIGNED NOT NULL,
  `scope` VARCHAR(16) NOT NULL DEFAULT 'record',
  `module` VARCHAR(96) DEFAULT NULL,
  `catalog_key` VARCHAR(120) DEFAULT NULL,
  `record_type` VARCHAR(160) DEFAULT NULL,
  `record_ref` VARCHAR(190) DEFAULT NULL,
  `match_field` VARCHAR(96) DEFAULT NULL,
  `match_value` VARCHAR(190) DEFAULT NULL,
  `file_id` BIGINT UNSIGNED DEFAULT NULL,
  `note` VARCHAR(500) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_legal_hold_items_hold` (`hold_id`),
  KEY `idx_legal_hold_items_scope` (`tenant_id`, `scope`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
