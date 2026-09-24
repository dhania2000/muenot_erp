-- =============================================================
-- SPEC 104 — Record Merge Engine
-- =============================================================
-- Transactional merge of duplicate records (fed by spec 103). Authorized users
-- pick a primary record, one or more secondaries, choose surviving field
-- values, re-point related records + attachments, and keep a full audit with a
-- rollback strategy.
--
-- Backing model (tenant-owned; register in lib/tenant-tables.ts):
--   merge_operations       : one merge run (primary + status + rollback state).
--   merge_sources          : the secondary records folded into the primary.
--   merge_field_selections : which value won for each field.
--   merge_related_moves    : related rows / attachments re-pointed, for rollback.
-- =============================================================

CREATE TABLE IF NOT EXISTS merge_operations (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  entity VARCHAR(60) NOT NULL,                 -- customers | vendors | contacts | ...
  primary_record_id VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- pending | in_progress | completed | failed | rolled_back
  candidate_id BIGINT DEFAULT NULL,            -- source dedupe_candidates row, if any
  primary_snapshot JSON DEFAULT NULL,          -- primary record before merge
  related_moved INT NOT NULL DEFAULT 0,
  attachments_moved INT NOT NULL DEFAULT 0,
  can_rollback TINYINT(1) NOT NULL DEFAULT 1,
  error_message VARCHAR(500) DEFAULT NULL,
  performed_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  rolled_back_at TIMESTAMP NULL DEFAULT NULL,
  KEY idx_merge_op_tenant (tenant_id),
  KEY idx_merge_op_entity (tenant_id, entity),
  KEY idx_merge_op_primary (tenant_id, entity, primary_record_id),
  KEY idx_merge_op_status (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS merge_sources (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  merge_id BIGINT NOT NULL,
  secondary_record_id VARCHAR(64) NOT NULL,
  record_snapshot JSON DEFAULT NULL,           -- full copy of the retired record
  disposition VARCHAR(20) NOT NULL DEFAULT 'archived', -- archived | soft_deleted | deleted
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_merge_src (merge_id, secondary_record_id),
  KEY idx_merge_src_tenant (tenant_id),
  KEY idx_merge_src_merge (merge_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS merge_field_selections (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  merge_id BIGINT NOT NULL,
  field VARCHAR(120) NOT NULL,
  chosen_value JSON DEFAULT NULL,
  chosen_from VARCHAR(64) DEFAULT NULL,        -- record id the value came from
  previous_value JSON DEFAULT NULL,            -- primary's old value, for rollback
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_merge_field (merge_id, field),
  KEY idx_merge_field_tenant (tenant_id),
  KEY idx_merge_field_merge (merge_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every related row / attachment re-pointed from a secondary to the primary,
-- so a rollback can put them back exactly where they were.
CREATE TABLE IF NOT EXISTS merge_related_moves (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  merge_id BIGINT NOT NULL,
  related_table VARCHAR(120) NOT NULL,
  related_record_id VARCHAR(64) NOT NULL,
  fk_column VARCHAR(120) NOT NULL,
  from_record_id VARCHAR(64) NOT NULL,
  to_record_id VARCHAR(64) NOT NULL,
  is_attachment TINYINT(1) NOT NULL DEFAULT 0,
  rolled_back TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_merge_move_tenant (tenant_id),
  KEY idx_merge_move_merge (merge_id),
  KEY idx_merge_move_related (related_table, related_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
