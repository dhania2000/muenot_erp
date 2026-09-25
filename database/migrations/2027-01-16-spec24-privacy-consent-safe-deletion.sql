-- Spec24 — Privacy, consent and safe deletion (#153-156).
-- ---------------------------------------------------------------------------
-- Persists the three privacy subsystems. Each store also self-heals its schema
-- at runtime (CREATE TABLE IF NOT EXISTS), so this migration is the explicit,
-- reviewable source of truth and keeps fresh databases converged with existing
-- installs. All tables are tenant-scoped; mutations are recorded to the
-- immutable audit log by the application layer.

-- 1. Consent & notice — an append-only ledger. The CURRENT state for a
--    (subject, purpose) pair is the latest event; grant/withdraw both append.
CREATE TABLE IF NOT EXISTS `privacy_consent_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT NOT NULL,
  `subject_email` VARCHAR(190) NOT NULL,
  `subject_name` VARCHAR(160) NULL,
  `purpose` VARCHAR(32) NOT NULL,
  `method` VARCHAR(32) NOT NULL,
  `status` VARCHAR(16) NOT NULL,
  `channel` VARCHAR(96) NULL,
  `notes` VARCHAR(1000) NULL,
  `actor_user_id` INT NULL,
  `actor_name` VARCHAR(160) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pce_tenant_subject` (`tenant_id`, `subject_email`, `purpose`),
  KEY `idx_pce_tenant_purpose` (`tenant_id`, `purpose`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Data-subject requests (DSAR) — export / anonymize / erase over one
--    person's personal data, gated by retention obligations and legal holds.
CREATE TABLE IF NOT EXISTS `privacy_subject_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT NOT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `subject_email` VARCHAR(190) NOT NULL,
  `subject_name` VARCHAR(160) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `reason` VARCHAR(1000) NULL,
  `requested_by_user_id` INT NULL,
  `requested_by_name` VARCHAR(160) NULL,
  `decided_by_name` VARCHAR(160) NULL,
  `decided_at` DATETIME NULL,
  `result_summary` TEXT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_psr_tenant_status` (`tenant_id`, `status`),
  KEY `idx_psr_tenant_subject` (`tenant_id`, `subject_email`, `kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Tenant deletion — full-tenant offboarding with a cooling period, a
--    mandatory export, a retention/backup proof and a final approval; blocked
--    absolutely while an active legal hold covers the tenant.
CREATE TABLE IF NOT EXISTS `tenant_deletion_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'requested',
  `reason` VARCHAR(1000) NULL,
  `cooling_days` INT NOT NULL DEFAULT 30,
  `cooling_ends_at` DATETIME NOT NULL,
  `export_job_id` BIGINT UNSIGNED NULL,
  `retention_proven` TINYINT(1) NOT NULL DEFAULT 0,
  `retention_proof_note` VARCHAR(1000) NULL,
  `requested_by_user_id` INT NULL,
  `requested_by_name` VARCHAR(160) NULL,
  `approved_by_name` VARCHAR(160) NULL,
  `approved_at` DATETIME NULL,
  `executed_by_name` VARCHAR(160) NULL,
  `executed_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tdr_tenant_status` (`tenant_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
