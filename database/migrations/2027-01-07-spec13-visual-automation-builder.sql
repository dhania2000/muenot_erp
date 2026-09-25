-- Spec13: visual automation builder (draft/publish/version/rollback, retries, asset actions).
-- lib/workflows/schema.ts applies the same changes idempotently at runtime; this file
-- is for installs that run migrations explicitly. Run once; MySQL 8.0+.

ALTER TABLE erp_workflows
  ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'draft',
  ADD COLUMN published_version INT UNSIGNED NULL,
  ADD COLUMN published_at DATETIME NULL;

-- Existing enabled workflows were already running; keep them live.
UPDATE erp_workflows SET status='published', published_version=version, published_at=UTC_TIMESTAMP() WHERE enabled=1;

ALTER TABLE erp_workflow_runs ADD COLUMN attempts INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS erp_workflow_versions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  workflow_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  definition JSON NOT NULL,
  changed_by INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY wf_idx (tenant_id, workflow_id, version)
) ENGINE=InnoDB;

-- Seed a version row for workflows that predate version history so rollback has a baseline.
INSERT INTO erp_workflow_versions (tenant_id, workflow_id, version, name, description, definition, changed_by)
SELECT w.tenant_id, w.id, w.version, w.name, w.description, w.definition, w.created_by
FROM erp_workflows w
WHERE NOT EXISTS (SELECT 1 FROM erp_workflow_versions v WHERE v.tenant_id=w.tenant_id AND v.workflow_id=w.id AND v.version=w.version);

CREATE TABLE IF NOT EXISTS erp_workflow_asset_actions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  run_id BIGINT UNSIGNED NOT NULL,
  asset_tag VARCHAR(64) NOT NULL,
  assigned_to INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY tenant_idx (tenant_id, id),
  KEY run_idx (tenant_id, run_id)
) ENGINE=InnoDB;
