-- =============================================================================
-- SPEC 91 — Master Data Governance
-- -----------------------------------------------------------------------------
-- Server-enforced governance for critical master data. Each governed record
-- carries a lifecycle status (draft -> pending_approval -> active / inactive /
-- archived), an owner, an approval authority and an effective date, and every
-- transition is written to an append-only change history.
--
-- Tenant-scoped and idempotent: every statement uses IF NOT EXISTS and no
-- existing table is touched, so this migration is safe to run more than once.
-- =============================================================================

-- Governance state: one row per governed master record.
CREATE TABLE IF NOT EXISTS master_data_governance (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  record_id VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  effective_date DATE DEFAULT NULL,
  owner_id INT DEFAULT NULL,
  approver_role VARCHAR(40) NOT NULL DEFAULT 'tenant_admin',
  approver_id INT DEFAULT NULL,
  submitted_by INT DEFAULT NULL,
  submitted_at TIMESTAMP NULL DEFAULT NULL,
  approved_by INT DEFAULT NULL,
  approved_at TIMESTAMP NULL DEFAULT NULL,
  version INT NOT NULL DEFAULT 1,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mdg_record (tenant_id, entity_type, record_id),
  KEY idx_mdg_status (tenant_id, entity_type, status),
  KEY idx_mdg_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only change history: one row per governed transition / edit.
CREATE TABLE IF NOT EXISTS master_data_governance_history (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  record_id VARCHAR(80) NOT NULL,
  change_type VARCHAR(30) NOT NULL,
  from_status VARCHAR(20) DEFAULT NULL,
  to_status VARCHAR(20) DEFAULT NULL,
  changed_fields JSON DEFAULT NULL,
  note VARCHAR(1000) NOT NULL DEFAULT '',
  effective_date DATE DEFAULT NULL,
  actor_id INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_mdg_hist_record (tenant_id, entity_type, record_id, id),
  KEY idx_mdg_hist_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
