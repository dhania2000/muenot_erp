-- =============================================================
-- SPEC 101 — Import Center
-- =============================================================
-- Centralized, generic import engine shared by every module. Supports the full
-- lifecycle: Upload -> Mapping -> Validation -> Preview -> Import -> Error report
-- -> Rollback -> History.
--
-- Backing model (all tenant-owned; register in lib/tenant-tables.ts):
--   import_jobs            : one row per uploaded file / import run.
--   import_column_mappings : source-column -> target-field mapping per job.
--   import_rows            : staged rows (raw + normalized) with per-row status.
--   import_errors          : validation / import errors, one row per problem.
--   import_batches         : records physically written, for rollback.
--   import_templates       : reusable saved mappings per module.
-- =============================================================

CREATE TABLE IF NOT EXISTS import_jobs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  module VARCHAR(60) NOT NULL,                 -- e.g. 'clients', 'sales_leads', 'hr_employees'
  entity VARCHAR(60) NOT NULL,                 -- logical target entity/adapter key
  file_name VARCHAR(255) NOT NULL,
  file_url VARCHAR(1024) DEFAULT NULL,         -- blob storage location
  file_size BIGINT DEFAULT NULL,
  file_hash VARCHAR(64) DEFAULT NULL,          -- sha256 for dedupe of re-uploads
  total_rows INT NOT NULL DEFAULT 0,
  valid_rows INT NOT NULL DEFAULT 0,
  invalid_rows INT NOT NULL DEFAULT 0,
  imported_rows INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'uploaded',
    -- uploaded | mapping | validating | validated | previewing
    -- | importing | completed | partially_completed | failed | rolled_back
  options JSON DEFAULT NULL,                    -- dedupe, upsert-key, skip-invalid, etc.
  error_summary JSON DEFAULT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY uq_import_jobs_tenant_hash (tenant_id, file_hash),
  KEY idx_import_jobs_tenant (tenant_id),
  KEY idx_import_jobs_status (tenant_id, status),
  KEY idx_import_jobs_module (tenant_id, module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS import_column_mappings (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  job_id BIGINT NOT NULL,
  source_column VARCHAR(255) NOT NULL,          -- header from the uploaded file
  source_index INT DEFAULT NULL,                -- 0-based position in the file
  target_field VARCHAR(120) DEFAULT NULL,       -- NULL = column ignored
  transform VARCHAR(60) DEFAULT NULL,           -- trim | upper | date | lookup ...
  default_value VARCHAR(255) DEFAULT NULL,
  is_required TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_import_map_job_source (job_id, source_column),
  KEY idx_import_map_tenant (tenant_id),
  KEY idx_import_map_job (job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS import_rows (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  job_id BIGINT NOT NULL,
  row_number INT NOT NULL,                       -- 1-based line in source file
  raw_data JSON NOT NULL,                        -- original values keyed by source column
  mapped_data JSON DEFAULT NULL,                 -- normalized values keyed by target field
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | valid | invalid | imported | skipped | failed
  target_record_id VARCHAR(64) DEFAULT NULL,     -- id of the row created/updated on import
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_import_rows_tenant (tenant_id),
  KEY idx_import_rows_job (job_id),
  KEY idx_import_rows_job_status (job_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS import_errors (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  job_id BIGINT NOT NULL,
  row_id BIGINT DEFAULT NULL,
  row_number INT DEFAULT NULL,
  field VARCHAR(120) DEFAULT NULL,
  error_code VARCHAR(60) NOT NULL,               -- required | format | range | duplicate | fk ...
  message VARCHAR(500) NOT NULL,
  severity VARCHAR(10) NOT NULL DEFAULT 'error',  -- error | warning
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_import_err_tenant (tenant_id),
  KEY idx_import_err_job (job_id),
  KEY idx_import_err_row (row_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Records physically written by an import, so a job can be rolled back.
CREATE TABLE IF NOT EXISTS import_batches (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  job_id BIGINT NOT NULL,
  target_table VARCHAR(120) NOT NULL,
  target_record_id VARCHAR(64) NOT NULL,
  operation VARCHAR(10) NOT NULL DEFAULT 'insert', -- insert | update
  previous_value JSON DEFAULT NULL,                -- snapshot for update rollback
  rolled_back TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_import_batch_tenant (tenant_id),
  KEY idx_import_batch_job (job_id),
  KEY idx_import_batch_record (target_table, target_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Reusable saved mappings so a recurring import needs mapping only once.
CREATE TABLE IF NOT EXISTS import_templates (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  module VARCHAR(60) NOT NULL,
  entity VARCHAR(60) NOT NULL,
  name VARCHAR(160) NOT NULL,
  mapping JSON NOT NULL,                          -- source -> target mapping definition
  options JSON DEFAULT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_import_tpl_tenant_name (tenant_id, module, entity, name),
  KEY idx_import_tpl_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
