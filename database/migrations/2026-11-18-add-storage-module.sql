-- =============================================================
-- Storage Module — SPEC 26–36
-- =============================================================
-- Consolidated schema for the customer-owned storage module. Every table here
-- is otherwise self-healed at runtime by the lib/storage/* `ensure*Schema()`
-- helpers (CREATE TABLE IF NOT EXISTS); this migration documents the canonical
-- shape and lets a fresh database be provisioned up front.
--
-- All tables are tenant-owned and accessed only through the tenant-scope
-- helpers (lib/tenant-scope.ts, lib/tenant-tables.ts), so every read/write is
-- isolated per tenant. Secrets (S3 secret keys) are encrypted at rest.
--
-- Idempotent: safe to run repeatedly and safe to run after runtime auto-heal.
-- =============================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- -------------------------------------------------------------
-- SPEC 26 / 27 — Customer storage connections + secure config + audit
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_storage_connections (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  provider VARCHAR(40) NOT NULL,
  name VARCHAR(190) NOT NULL,
  bucket VARCHAR(255) NOT NULL,
  region VARCHAR(120) DEFAULT NULL,
  endpoint VARCHAR(500) DEFAULT NULL,
  access_key_id VARCHAR(255) DEFAULT NULL,
  secret_access_key TEXT DEFAULT NULL,
  force_path_style TINYINT(1) NOT NULL DEFAULT 0,
  public_base_url VARCHAR(500) DEFAULT NULL,
  path_prefix VARCHAR(500) DEFAULT NULL,
  server_side_encryption VARCHAR(40) NOT NULL DEFAULT 'none',
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tsc_tenant (tenant_id),
  KEY idx_tsc_active (tenant_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tenant_storage_audit (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  connection_id BIGINT DEFAULT NULL,
  action VARCHAR(40) NOT NULL,
  detail VARCHAR(500) DEFAULT NULL,
  user_id INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tsca_tenant (tenant_id),
  KEY idx_tsca_conn (connection_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Storage → module/sub-module folder mappings (migration panel)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_storage_migrations (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  module_key VARCHAR(80) NOT NULL,
  module_label VARCHAR(190) NOT NULL,
  submodule_key VARCHAR(120) NOT NULL,
  submodule_label VARCHAR(190) NOT NULL,
  connection_id BIGINT DEFAULT NULL,
  folder VARCHAR(500) NOT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tsm_target (tenant_id, module_key, submodule_key),
  KEY idx_tsm_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 32 — Centralized file metadata (normalized per-object model)
-- SPEC 36 — retention_override column lives on this table
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_objects (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  file_ref VARCHAR(40) NOT NULL,
  owner_id INT DEFAULT NULL,
  module VARCHAR(60) NOT NULL,
  entity_type VARCHAR(80) DEFAULT NULL,
  entity_id VARCHAR(120) DEFAULT NULL,
  object_key VARCHAR(1024) NOT NULL,
  provider VARCHAR(40) NOT NULL,
  filename VARCHAR(500) DEFAULT NULL,
  mime_type VARCHAR(255) DEFAULT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  checksum_sha256 CHAR(64) DEFAULT NULL,
  upload_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  is_current TINYINT(1) NOT NULL DEFAULT 1,
  supersedes_id BIGINT DEFAULT NULL,
  classification VARCHAR(20) NOT NULL DEFAULT 'internal',
  retention_policy VARCHAR(30) NOT NULL DEFAULT 'default',
  retention_expires_at DATETIME DEFAULT NULL,
  retention_override TINYINT(1) NOT NULL DEFAULT 0,
  legal_hold TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME DEFAULT NULL,
  deleted_by INT DEFAULT NULL,
  UNIQUE KEY uq_fo_tenant_key (tenant_id, object_key),
  UNIQUE KEY uq_fo_tenant_ref (tenant_id, file_ref),
  KEY idx_fo_tenant (tenant_id),
  KEY idx_fo_entity (tenant_id, module, entity_type, entity_id),
  KEY idx_fo_status (tenant_id, upload_status),
  KEY idx_fo_checksum (tenant_id, checksum_sha256),
  KEY idx_fo_retention (retention_expires_at),
  KEY idx_fo_current (tenant_id, is_current)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 33 — File / document version audit trail
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_version_audit (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  file_id BIGINT NOT NULL,
  file_ref VARCHAR(40) DEFAULT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  action VARCHAR(20) NOT NULL,
  detail VARCHAR(500) DEFAULT NULL,
  user_id INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_fva_tenant (tenant_id),
  KEY idx_fva_file (tenant_id, file_id),
  KEY idx_fva_action (tenant_id, action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 34 — Malware / file-security scanning
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_security_scans (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  file_id BIGINT NOT NULL,
  file_ref VARCHAR(40) DEFAULT NULL,
  object_key VARCHAR(1024) NOT NULL,
  scan_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  safety VARCHAR(12) NOT NULL DEFAULT 'unknown',
  quarantine_status VARCHAR(16) NOT NULL DEFAULT 'quarantined',
  provider VARCHAR(60) DEFAULT NULL,
  findings TEXT DEFAULT NULL,
  detail VARCHAR(500) DEFAULT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  approved TINYINT(1) NOT NULL DEFAULT 0,
  approved_by INT DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  requested_by INT DEFAULT NULL,
  scanned_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fss_tenant_file (tenant_id, file_id),
  KEY idx_fss_tenant (tenant_id),
  KEY idx_fss_status (tenant_id, scan_status),
  KEY idx_fss_quarantine (tenant_id, quarantine_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 30 — Large / resumable multipart upload sessions + parts
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_upload_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  upload_id VARCHAR(1024) NOT NULL,
  storage_key VARCHAR(1024) NOT NULL,
  provider VARCHAR(40) NOT NULL,
  filename VARCHAR(500) NOT NULL,
  content_type VARCHAR(255) DEFAULT NULL,
  total_size BIGINT NOT NULL DEFAULT 0,
  part_size BIGINT NOT NULL DEFAULT 0,
  total_parts INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  category VARCHAR(40) NOT NULL DEFAULT 'other',
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_sus_tenant (tenant_id),
  KEY idx_sus_status (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS storage_upload_parts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  session_id BIGINT NOT NULL,
  part_number INT NOT NULL,
  etag VARCHAR(512) NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sup_session_part (session_id, part_number),
  KEY idx_sup_tenant (tenant_id),
  KEY idx_sup_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 35 — Tenant storage quota settings
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_quota_settings (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  custom_quota_bytes BIGINT DEFAULT NULL,
  warn_threshold_percent TINYINT UNSIGNED NOT NULL DEFAULT 80,
  hard_limit TINYINT(1) NOT NULL DEFAULT 0,
  enforced TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sqs_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 36 — Configurable retention: default settings + per-module rules
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_retention_settings (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  default_mode VARCHAR(12) NOT NULL DEFAULT 'duration',
  default_amount INT UNSIGNED NOT NULL DEFAULT 7,
  default_unit VARCHAR(8) NOT NULL DEFAULT 'years',
  auto_cleanup_enabled TINYINT(1) NOT NULL DEFAULT 0,
  last_run_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_srs_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS storage_retention_rules (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  module VARCHAR(60) NOT NULL,
  mode VARCHAR(12) NOT NULL DEFAULT 'duration',
  amount INT UNSIGNED NOT NULL DEFAULT 7,
  unit VARCHAR(8) NOT NULL DEFAULT 'years',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_srr_tenant_module (tenant_id, module),
  KEY idx_srr_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
