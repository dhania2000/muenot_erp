-- SPEC 16 — Integration sync & conflict resolution (#90-91)
-- ---------------------------------------------------------------------------
-- Per-tenant sync of external provider records (Spec 15 marketplace connectors)
-- into centralized master data (Spec 90). Implements initial + incremental sync
-- driven by opaque, versioned cursors with per-page checkpoints, bounded retry
-- with exponential backoff on provider outage, stale-cursor safe restarts,
-- three-way conflict detection (external vs ERP vs baseline) with ERP-wins /
-- external-wins / manual-merge resolution, and an immutable append-only sync log
-- that makes replay apply each record at-most-once (no duplicate master rows).
--
-- Every table is tenant-scoped (registered in lib/tenant-tables.ts). All reads
-- and writes go through the tenant-bound engine (lib/integration-sync/store.ts),
-- whose statements always carry a `tenant_id` predicate, so one tenant can never
-- see, run, resolve or replay another tenant's sync. The store self-heals these
-- tables at runtime (CREATE TABLE IF NOT EXISTS); this migration is the
-- authoritative schema of record and MUST stay in sync with runEnsure() there.

-- One configured (provider × entity → master) sync feed per tenant. Holds the
-- schedule, the last committed cursor position, an optimistic-lock version, a
-- generation tag (bumped on baseline reset to invalidate in-flight cursors) and
-- a lease (lease_until) that serializes concurrent runs of the same feed.
CREATE TABLE IF NOT EXISTS `integration_sync_connections` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `provider_key` VARCHAR(64) NOT NULL,
  `entity_kind` VARCHAR(64) NOT NULL,
  `master_kind` VARCHAR(64) NOT NULL,
  `label` VARCHAR(160) NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `cron_expression` VARCHAR(120) NULL,
  `config` JSON NULL,
  `cursor_position` VARCHAR(500) NULL,
  `generation` INT UNSIGNED NOT NULL DEFAULT 0,
  `status` ENUM('idle','syncing','error') NOT NULL DEFAULT 'idle',
  `last_error` VARCHAR(500) NULL,
  `last_run_id` BIGINT UNSIGNED NULL,
  `last_synced_at` DATETIME NULL,
  `next_run_at` DATETIME NULL,
  `lease_until` DATETIME NULL,
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `created_by` BIGINT UNSIGNED NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_sync_conn` (`tenant_id`, `provider_key`, `entity_kind`),
  KEY `idx_sync_conn_due` (`enabled`, `status`, `next_run_at`),
  KEY `idx_sync_conn_tenant` (`tenant_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One execution (or resumable attempt) of a sync. Keyed by an idempotency slot
-- so duplicate triggers collapse into a single run; carries per-page checkpoint
-- counters + cursor for crash/outage recovery and a backoff deadline for retry.
CREATE TABLE IF NOT EXISTS `integration_sync_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `mode` ENUM('initial','incremental') NOT NULL,
  `status` ENUM('pending','running','succeeded','failed','partial') NOT NULL DEFAULT 'pending',
  `idempotency_key` VARCHAR(191) NOT NULL,
  `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts` INT UNSIGNED NOT NULL DEFAULT 5,
  `pages` INT UNSIGNED NOT NULL DEFAULT 0,
  `fetched` INT UNSIGNED NOT NULL DEFAULT 0,
  `applied` INT UNSIGNED NOT NULL DEFAULT 0,
  `skipped` INT UNSIGNED NOT NULL DEFAULT 0,
  `conflicts` INT UNSIGNED NOT NULL DEFAULT 0,
  `errors` INT UNSIGNED NOT NULL DEFAULT 0,
  `checkpoint_cursor` VARCHAR(500) NULL,
  `next_retry_at` DATETIME NULL,
  `error_message` TEXT NULL,
  `triggered_by` BIGINT UNSIGNED NULL,
  `trigger_source` ENUM('manual','scheduler') NOT NULL DEFAULT 'manual',
  `started_at` DATETIME NULL,
  `finished_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_sync_run_idem` (`tenant_id`, `idempotency_key`),
  KEY `idx_sync_run_conn` (`tenant_id`, `connection_id`, `created_at`),
  KEY `idx_sync_run_retry` (`status`, `next_retry_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The tenant-scoped mapping from an external record id to the canonical master
-- code, plus the last-synced baseline fingerprints (external + local) that drive
-- three-way change classification / conflict detection.
CREATE TABLE IF NOT EXISTS `integration_record_mappings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `external_id` VARCHAR(191) NOT NULL,
  `master_kind` VARCHAR(64) NOT NULL,
  `code` VARCHAR(64) NOT NULL,
  `external_fingerprint` VARCHAR(32) NULL,
  `local_fingerprint` VARCHAR(32) NULL,
  `status` ENUM('active','conflict','archived') NOT NULL DEFAULT 'active',
  `last_synced_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_mapping_ext` (`tenant_id`, `connection_id`, `external_id`),
  KEY `idx_mapping_code` (`tenant_id`, `connection_id`, `code`),
  KEY `idx_mapping_status` (`tenant_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Detected conflicts awaiting resolution. `open_marker` mirrors external_id only
-- while open (NULLed on resolve) so the UNIQUE key permits at most one OPEN
-- conflict per record while allowing many historical resolved rows.
CREATE TABLE IF NOT EXISTS `integration_sync_conflicts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `external_id` VARCHAR(191) NOT NULL,
  `master_kind` VARCHAR(64) NOT NULL,
  `code` VARCHAR(64) NOT NULL,
  `status` ENUM('open','resolved') NOT NULL DEFAULT 'open',
  `open_marker` VARCHAR(191) NULL,
  `resolution` ENUM('erp_wins','external_wins','manual') NULL,
  `external_record` JSON NULL,
  `local_record` JSON NULL,
  `detected_run_id` BIGINT UNSIGNED NULL,
  `resolved_by` BIGINT UNSIGNED NULL,
  `resolved_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_conflict_open` (`tenant_id`, `connection_id`, `open_marker`),
  KEY `idx_conflict_tenant` (`tenant_id`, `status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Immutable, append-only per-record sync log. The UNIQUE (tenant, connection,
-- event_key) — where event_key embeds the external fingerprint — guarantees a
-- record is applied at-most-once, making a full run replay safe (no duplicates).
CREATE TABLE IF NOT EXISTS `integration_sync_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `connection_id` BIGINT UNSIGNED NOT NULL,
  `run_id` BIGINT UNSIGNED NULL,
  `event_key` VARCHAR(191) NOT NULL,
  `external_id` VARCHAR(191) NOT NULL,
  `action` VARCHAR(32) NOT NULL,
  `detail` JSON NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_log_event` (`tenant_id`, `connection_id`, `event_key`),
  KEY `idx_log_run` (`tenant_id`, `run_id`, `id`),
  KEY `idx_log_ext` (`tenant_id`, `connection_id`, `external_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
