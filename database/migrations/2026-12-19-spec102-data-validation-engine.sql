-- =============================================================
-- SPEC 102 — Data Validation Engine
-- =============================================================
-- Reusable, centralized validation framework consumed by APIs, forms and the
-- Import Center (spec 101). Rules are declarative and stored per tenant so the
-- same entity is validated consistently everywhere.
--
-- Supported rule kinds:
--   required | format | range | uniqueness | cross_field | conditional
--   | business_rule
--
-- Backing model (tenant-owned; register in lib/tenant-tables.ts):
--   validation_rule_sets : a named group of rules bound to one entity.
--   validation_rules     : individual rule definitions.
--   validation_runs      : audit of validation executions + outcomes.
-- =============================================================

CREATE TABLE IF NOT EXISTS validation_rule_sets (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  entity VARCHAR(80) NOT NULL,                 -- 'clients', 'sales_leads', ...
  name VARCHAR(160) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vrs_tenant_entity_name (tenant_id, entity, name),
  KEY idx_vrs_tenant (tenant_id),
  KEY idx_vrs_entity (tenant_id, entity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS validation_rules (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  rule_set_id BIGINT NOT NULL,
  field VARCHAR(120) DEFAULT NULL,             -- NULL for cross_field/business_rule spanning many
  rule_type VARCHAR(30) NOT NULL,
    -- required | format | range | uniqueness | cross_field | conditional | business_rule
  -- Parameters interpreted per rule_type:
  --   format      -> { pattern, format: 'email'|'phone'|'gstin'|... }
  --   range       -> { min, max, minDate, maxDate }
  --   uniqueness  -> { scope: ['tenant_id', ...], caseInsensitive }
  --   cross_field -> { expression, fields: [...] }
  --   conditional -> { when: {...}, then: {...} }
  --   business_rule -> { handler: 'creditLimit', config: {...} }
  params JSON DEFAULT NULL,
  condition JSON DEFAULT NULL,                 -- optional gate: only apply when this matches
  severity VARCHAR(10) NOT NULL DEFAULT 'error', -- error | warning
  message VARCHAR(500) DEFAULT NULL,           -- override for the default message
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_vr_tenant (tenant_id),
  KEY idx_vr_set (rule_set_id),
  KEY idx_vr_set_active (rule_set_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS validation_runs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  entity VARCHAR(80) NOT NULL,
  rule_set_id BIGINT DEFAULT NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'api',   -- api | form | import
  source_ref VARCHAR(64) DEFAULT NULL,         -- e.g. import job id / request id
  records_checked INT NOT NULL DEFAULT 0,
  passed INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  warnings INT NOT NULL DEFAULT 0,
  result JSON DEFAULT NULL,                     -- detailed per-field outcomes
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_vrun_tenant (tenant_id),
  KEY idx_vrun_entity (tenant_id, entity),
  KEY idx_vrun_source (tenant_id, source, source_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
