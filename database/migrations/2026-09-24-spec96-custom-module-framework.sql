-- =============================================================================
-- SPEC 96 — Custom Module Framework
-- -----------------------------------------------------------------------------
-- Metadata-driven, lightweight tenant-created modules: a custom entity with its
-- own fields, views, forms, permissions, workflow, reports and attachments.
-- custom_modules holds each module DEFINITION (as JSON); a single generic
-- custom_module_records table backs EVERY module (the module id discriminates
-- rows), so a tenant can add unlimited modules without a schema migration —
-- which is what keeps tenant isolation a single predicate.
--
-- The application self-heals these tables at runtime
-- (lib/custom-modules/schema.ts #ensureCustomModuleSchema); this migration is
-- the canonical, idempotent record of that schema.
-- =============================================================================

-- Module definitions. UNIQUE (tenant, slug).
CREATE TABLE IF NOT EXISTS custom_modules (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  slug VARCHAR(60) NOT NULL,
  name VARCHAR(80) NOT NULL,
  plural_name VARCHAR(100) NOT NULL DEFAULT '',
  description VARCHAR(1000) NOT NULL DEFAULT '',
  icon VARCHAR(40) NOT NULL DEFAULT 'Blocks',
  nav_group VARCHAR(60) NOT NULL DEFAULT 'Custom',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  allow_attachments TINYINT NOT NULL DEFAULT 0,
  fields_json JSON NOT NULL,
  list_view_json JSON NOT NULL,
  permissions_json JSON NOT NULL,
  workflow_json JSON NOT NULL,
  reports_json JSON NOT NULL,
  version INT NOT NULL DEFAULT 1,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_custom_module_slug (tenant_id, slug),
  KEY idx_custom_module_tenant (tenant_id),
  KEY idx_custom_module_status (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Generic record store shared by every module. Indexed by (tenant, module) and
-- by (tenant, module, state) for list filters.
CREATE TABLE IF NOT EXISTS custom_module_records (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  module_id BIGINT NOT NULL,
  module_version INT NOT NULL DEFAULT 1,
  state VARCHAR(60) DEFAULT NULL,
  values_json JSON NOT NULL,
  attachments_json JSON NOT NULL,
  created_by INT DEFAULT NULL,
  updated_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_custom_module_rec_module (tenant_id, module_id),
  KEY idx_custom_module_rec_state (tenant_id, module_id, state),
  KEY idx_custom_module_rec_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
