-- =============================================================
-- SPEC 103 — Duplicate Detection
-- =============================================================
-- Reusable duplicate detection across duplicate-prone entities:
--   customers | vendors | employees | leads | contacts | documents | masters
-- Uses configurable matching fields with per-field weight and comparison
-- strategy (exact / normalized / fuzzy). Feeds the merge engine (spec 104).
--
-- Backing model (tenant-owned; register in lib/tenant-tables.ts):
--   dedupe_configs       : matching rules per entity.
--   dedupe_config_fields : fields + weights + match strategy for a config.
--   dedupe_candidates    : detected potential-duplicate pairs.
-- =============================================================

CREATE TABLE IF NOT EXISTS dedupe_configs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  entity VARCHAR(60) NOT NULL,                 -- customers | vendors | employees | leads | contacts | documents | masters
  name VARCHAR(160) NOT NULL,
  match_threshold DECIMAL(5,2) NOT NULL DEFAULT 80.00,  -- % score to flag as candidate
  auto_block TINYINT(1) NOT NULL DEFAULT 0,    -- block create at 100% match
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dedupe_cfg_tenant_entity_name (tenant_id, entity, name),
  KEY idx_dedupe_cfg_tenant (tenant_id),
  KEY idx_dedupe_cfg_entity (tenant_id, entity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dedupe_config_fields (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  config_id BIGINT NOT NULL,
  field VARCHAR(120) NOT NULL,
  strategy VARCHAR(20) NOT NULL DEFAULT 'exact', -- exact | normalized | fuzzy | phonetic
  weight DECIMAL(5,2) NOT NULL DEFAULT 1.00,     -- contribution to the match score
  fuzzy_threshold DECIMAL(5,2) DEFAULT NULL,     -- similarity % for fuzzy/phonetic
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dedupe_fld_config_field (config_id, field),
  KEY idx_dedupe_fld_tenant (tenant_id),
  KEY idx_dedupe_fld_config (config_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dedupe_candidates (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  config_id BIGINT DEFAULT NULL,
  entity VARCHAR(60) NOT NULL,
  record_id_a VARCHAR(64) NOT NULL,
  record_id_b VARCHAR(64) NOT NULL,
  score DECIMAL(5,2) NOT NULL,                  -- computed match %
  matched_fields JSON DEFAULT NULL,             -- per-field contribution detail
  status VARCHAR(20) NOT NULL DEFAULT 'open',   -- open | confirmed | dismissed | merged
  reviewed_by INT DEFAULT NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dedupe_pair (tenant_id, entity, record_id_a, record_id_b),
  KEY idx_dedupe_cand_tenant (tenant_id),
  KEY idx_dedupe_cand_entity_status (tenant_id, entity, status),
  KEY idx_dedupe_cand_score (tenant_id, score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
