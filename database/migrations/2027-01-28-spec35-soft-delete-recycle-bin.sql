-- Spec35 — Soft delete, version history and recovery (#110-113).
-- ---------------------------------------------------------------------------
-- Persists the soft-delete / recycle-bin / versioned-edit subsystem behind
-- lib/recycle-bin/store.ts. The store also self-heals its schema at runtime
-- (CREATE TABLE IF NOT EXISTS + additive ALTERs), so this migration is the
-- explicit, reviewable source of truth and keeps fresh databases converged with
-- existing installs.
--
-- Everything is tenant-scoped; every mutation is written to the immutable,
-- hash-chained audit ledger by the application layer (lib/audit-log-store.ts).
-- Legal-hold protection and the approval workflow are reused, not duplicated:
-- holds are re-checked live against legal_holds/legal_hold_items and sensitive
-- edits are routed through the Approval Authority engine.

-- 1. Recycle bin ledger — one row per soft delete. The snapshot + hash make the
--    entry an immutable tombstone; the underlying row is kept in place (same PK
--    and foreign keys) so a restore is reference-preserving by construction.
--    Only an expiry/manual PURGE physically removes the row.
CREATE TABLE IF NOT EXISTS `recycle_bin_entries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `entity_type` VARCHAR(120) NOT NULL,
  `entity_table` VARCHAR(120) NOT NULL,
  `entity_pk` VARCHAR(190) NOT NULL,
  `entity_label` VARCHAR(255) DEFAULT NULL,
  `module` VARCHAR(96) DEFAULT NULL,
  `snapshot` MEDIUMTEXT NOT NULL,
  `snapshot_hash` CHAR(64) DEFAULT NULL,
  `reason` VARCHAR(1000) DEFAULT NULL,
  `status` ENUM('recycled','restored','purged') NOT NULL DEFAULT 'recycled',
  `legal_hold` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_by` INT UNSIGNED DEFAULT NULL,
  `deleted_by_name` VARCHAR(190) DEFAULT NULL,
  `deleted_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `restore_deadline` DATETIME DEFAULT NULL,
  `restored_by` INT UNSIGNED DEFAULT NULL,
  `restored_at` DATETIME DEFAULT NULL,
  `restore_key` VARCHAR(128) DEFAULT NULL,
  `purged_by` INT UNSIGNED DEFAULT NULL,
  `purged_at` DATETIME DEFAULT NULL,
  `idempotency_key` VARCHAR(128) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_recycle_idem` (`tenant_id`, `idempotency_key`),
  KEY `idx_recycle_tenant_status` (`tenant_id`, `status`),
  KEY `idx_recycle_entity` (`tenant_id`, `entity_type`, `entity_pk`),
  KEY `idx_recycle_deadline` (`status`, `restore_deadline`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Per-tenant recycle-bin settings — the restore window (in days) that bounds
--    how long a soft-deleted record stays recoverable before it becomes
--    purgeable. Defaults to 30 days (DEFAULT_RESTORE_WINDOW_DAYS).
CREATE TABLE IF NOT EXISTS `recycle_bin_settings` (
  `tenant_id` INT UNSIGNED NOT NULL,
  `restore_window_days` INT UNSIGNED NOT NULL DEFAULT 30,
  `updated_by` INT UNSIGNED DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Versioned sensitive edits — proposed values that must clear approval before
--    being PUBLISHED onto the live record. base_version_no / base_row_version /
--    base_values capture what the author saw so a stale or concurrent edit is
--    detected deterministically at publish time (see version-model.ts).
CREATE TABLE IF NOT EXISTS `record_versions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `entity_type` VARCHAR(120) NOT NULL,
  `entity_pk` VARCHAR(190) NOT NULL,
  `version_no` INT UNSIGNED NOT NULL,
  `base_version_no` INT UNSIGNED NOT NULL DEFAULT 0,
  `base_row_version` INT UNSIGNED DEFAULT NULL,
  `status` ENUM('draft','pending','approved','published','rejected','superseded') NOT NULL DEFAULT 'draft',
  `payload` MEDIUMTEXT NOT NULL,
  `base_values` MEDIUMTEXT DEFAULT NULL,
  `before_values` MEDIUMTEXT DEFAULT NULL,
  `summary` VARCHAR(500) DEFAULT NULL,
  `revert_of_version_id` BIGINT UNSIGNED DEFAULT NULL,
  `approval_mode` ENUM('engine','peer') DEFAULT NULL,
  `approval_request_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_by_name` VARCHAR(190) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `submitted_at` DATETIME DEFAULT NULL,
  `decided_by` INT UNSIGNED DEFAULT NULL,
  `decided_by_name` VARCHAR(190) DEFAULT NULL,
  `decided_at` DATETIME DEFAULT NULL,
  `decision_note` VARCHAR(500) DEFAULT NULL,
  `published_by` INT UNSIGNED DEFAULT NULL,
  `published_at` DATETIME DEFAULT NULL,
  `idempotency_key` VARCHAR(128) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_version_no` (`tenant_id`, `entity_type`, `entity_pk`, `version_no`),
  UNIQUE KEY `uniq_version_idem` (`tenant_id`, `idempotency_key`),
  KEY `idx_version_entity` (`tenant_id`, `entity_type`, `entity_pk`),
  KEY `idx_version_status` (`tenant_id`, `status`),
  KEY `idx_version_approval` (`tenant_id`, `approval_request_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Per-tenant policy — which registry fields of a critical entity require the
--    version + approval workflow. Absent row => the entity's default gated set.
CREATE TABLE IF NOT EXISTS `record_version_policies` (
  `tenant_id` INT UNSIGNED NOT NULL,
  `entity_type` VARCHAR(120) NOT NULL,
  `fields` TEXT NOT NULL,
  `updated_by` INT UNSIGNED DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`, `entity_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. The consistent soft-delete trio on every critical table (see
--    lib/recycle-bin/registry.ts). Soft delete sets deleted_at/deleted_by/
--    delete_reason and keeps the row in place; NULLing them again restores it.
--    Additive and idempotent — safe to re-run. Extend this block as more
--    critical entities are registered.
ALTER TABLE `clients`
  ADD COLUMN IF NOT EXISTS `deleted_at` DATETIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `deleted_by` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `delete_reason` VARCHAR(1000) DEFAULT NULL;
