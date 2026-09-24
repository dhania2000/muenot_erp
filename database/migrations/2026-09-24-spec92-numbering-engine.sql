-- =============================================================================
-- SPEC 92 — Numbering Engine
-- -----------------------------------------------------------------------------
-- Centralized, tenant- and entity-scoped automatic ID/number generation with
-- prefix, suffix, sequence, fiscal-year reset rules and custom formats
-- (e.g. EMP-2026-000001, INV-2026-000001, VEN-000001).
--
-- The application self-heals these tables at runtime (lib/numbering/schema.ts
-- #ensureNumberingSchema); this migration is the canonical, idempotent record
-- of that schema. Concurrency-safe, duplicate-free allocation relies on the
-- UNIQUE key on numbering_counters plus an atomic upsert.
--
-- This is an opt-in counter store. The legacy `record_id_sequences` table
-- (lib/record-ids.ts) is left untouched.
-- =============================================================================

-- Per-tenant, per-entity format + reset configuration.
CREATE TABLE IF NOT EXISTS numbering_rules (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  entity VARCHAR(40) NOT NULL,
  prefix VARCHAR(20) NOT NULL DEFAULT '',
  suffix VARCHAR(20) NOT NULL DEFAULT '',
  padding TINYINT NOT NULL DEFAULT 6,
  reset_rule VARCHAR(20) NOT NULL DEFAULT 'never',
  format VARCHAR(120) NOT NULL DEFAULT '{PREFIX}-{SEQ}',
  fiscal_start_month TINYINT NOT NULL DEFAULT 4,
  start_number BIGINT NOT NULL DEFAULT 1,
  active TINYINT NOT NULL DEFAULT 1,
  updated_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_numbering_rule (tenant_id, entity),
  KEY idx_numbering_rule_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Running sequence per (tenant, entity, period). The UNIQUE key + atomic
-- upsert on this table is what makes concurrent allocation duplicate-free.
CREATE TABLE IF NOT EXISTS numbering_counters (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  entity VARCHAR(40) NOT NULL,
  period_key VARCHAR(20) NOT NULL,
  next_number BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_numbering_counter (tenant_id, entity, period_key),
  KEY idx_numbering_counter_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
