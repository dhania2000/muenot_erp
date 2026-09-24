-- =============================================================================
-- SPEC 93 — Reference Number Management
-- -----------------------------------------------------------------------------
-- Lets business documents carry internal numbers and external references
-- (customer / vendor / PO / contract), with configurable duplicate detection.
--
-- The application self-heals these tables at runtime
-- (lib/references/schema.ts #ensureReferenceSchema); this migration is the
-- canonical, idempotent record of that schema.
-- =============================================================================

-- Per-tenant, per-(document type, reference type) configuration.
CREATE TABLE IF NOT EXISTS reference_configs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  document_type VARCHAR(40) NOT NULL,
  ref_type VARCHAR(20) NOT NULL,
  enabled TINYINT NOT NULL DEFAULT 1,
  required TINYINT NOT NULL DEFAULT 0,
  duplicate_policy VARCHAR(10) NOT NULL DEFAULT 'off',
  updated_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reference_config (tenant_id, document_type, ref_type),
  KEY idx_reference_config_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Reference values attached to documents. The UNIQUE key keeps one value per
-- reference type per document; the normalized index powers duplicate detection.
CREATE TABLE IF NOT EXISTS document_references (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  document_type VARCHAR(40) NOT NULL,
  document_id VARCHAR(80) NOT NULL,
  ref_type VARCHAR(20) NOT NULL,
  ref_value VARCHAR(120) NOT NULL,
  normalized VARCHAR(120) NOT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_document_reference (tenant_id, document_type, document_id, ref_type),
  KEY idx_document_reference_dup (tenant_id, document_type, ref_type, normalized),
  KEY idx_document_reference_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
