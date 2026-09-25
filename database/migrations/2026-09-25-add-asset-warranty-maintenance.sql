-- Spec61 (#234-239): Asset warranty coverage + maintenance log.
-- Both reference Finance → fixed_assets.asset_id (source of truth). No asset
-- master data or depreciation is duplicated here. Warranty/service reminders
-- flow through the unified Document Expiry sweep (lib/expiry/*). The audit trail
-- reuses employee_asset_audit (asset-scoped rows). These tables are also created
-- defensively at runtime by ensureAssetLifecycleSchema() in lib/asset-lifecycle.

CREATE TABLE IF NOT EXISTS `asset_warranties` (
  `id`                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `warranty_id`            VARCHAR(30) NOT NULL,
  `finance_fixed_asset_id` VARCHAR(30) NOT NULL,
  `provider`               VARCHAR(190) NOT NULL,
  `warranty_type`          VARCHAR(30) NOT NULL DEFAULT 'Manufacturer',
  `coverage`               TEXT DEFAULT NULL,
  `start_date`             DATE DEFAULT NULL,
  `expiry_date`            DATE NOT NULL,
  `reference_no`           VARCHAR(120) DEFAULT NULL,
  `cost`                   DECIMAL(15,2) NOT NULL DEFAULT 0,
  `reminder_days`          INT UNSIGNED NOT NULL DEFAULT 30,
  `notes`                  TEXT DEFAULT NULL,
  `archived_at`            DATETIME DEFAULT NULL,
  `created_by`             INT UNSIGNED DEFAULT NULL,
  `created_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_warranty_id` (`warranty_id`),
  KEY `idx_warranty_asset` (`finance_fixed_asset_id`),
  KEY `idx_warranty_expiry` (`expiry_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `asset_maintenance_records` (
  `id`                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `maintenance_id`         VARCHAR(30) NOT NULL,
  `finance_fixed_asset_id` VARCHAR(30) NOT NULL,
  `assignment_id`          VARCHAR(30) DEFAULT NULL,
  `maintenance_type`       VARCHAR(30) NOT NULL DEFAULT 'Corrective',
  `status`                 VARCHAR(20) NOT NULL DEFAULT 'Scheduled',
  `scheduled_date`         DATE DEFAULT NULL,
  `performed_date`         DATE DEFAULT NULL,
  `vendor_party_id`        VARCHAR(30) DEFAULT NULL,
  `vendor_name`            VARCHAR(190) DEFAULT NULL,
  `cost`                   DECIMAL(15,2) NOT NULL DEFAULT 0,
  `description`            TEXT NOT NULL,
  `next_service_date`      DATE DEFAULT NULL,
  `reminder_days`          INT UNSIGNED NOT NULL DEFAULT 15,
  `notes`                  TEXT DEFAULT NULL,
  `idempotency_key`        VARCHAR(80) DEFAULT NULL,
  `created_by`             INT UNSIGNED DEFAULT NULL,
  `created_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_maintenance_id` (`maintenance_id`),
  UNIQUE KEY `uq_maintenance_idem` (`idempotency_key`),
  KEY `idx_maint_asset` (`finance_fixed_asset_id`),
  KEY `idx_maint_status` (`status`),
  KEY `idx_maint_next_service` (`next_service_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
