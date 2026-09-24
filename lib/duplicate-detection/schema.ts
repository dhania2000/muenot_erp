import "server-only"
/**
 * SPEC 103 — Duplicate Detection schema (idempotent self-heal).
 * ---------------------------------------------------------------------------
 * Same migration-runner-free pattern as the rest of the codebase: every
 * statement is CREATE TABLE IF NOT EXISTS, safe to run on every request and
 * against a live production database.
 *
 * Two tenant-owned tables (register in lib/tenant-tables.ts):
 *   - dup_candidates : one row per detected potential duplicate pair
 *                      (entity_type, primary_id vs. duplicate_id) with its score,
 *                      classification, the fields that matched, and the review
 *                      status (pending / dismissed / merged). UNIQUE per pair so
 *                      re-running detection updates rather than duplicates.
 *   - dup_merge_log  : an audit row for each completed merge — who merged which
 *                      record into which, and the field-level plan that was
 *                      applied — so a merge is always explainable after the fact.
 */
import { query } from "@/lib/db"

let ensured: Promise<void> | null = null

export function ensureDuplicateSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS dup_candidates (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      entity_type VARCHAR(40) NOT NULL,
      primary_id VARCHAR(80) NOT NULL,
      duplicate_id VARCHAR(80) NOT NULL,
      score DECIMAL(5,4) NOT NULL DEFAULT 0,
      classification VARCHAR(16) NOT NULL DEFAULT 'possible',
      matched_fields_json JSON DEFAULT NULL,
      hard_match TINYINT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      reviewed_by INT DEFAULT NULL,
      reviewed_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dup_pair (tenant_id, entity_type, primary_id, duplicate_id),
      KEY idx_dup_entity_status (tenant_id, entity_type, status),
      KEY idx_dup_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS dup_merge_log (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      entity_type VARCHAR(40) NOT NULL,
      surviving_id VARCHAR(80) NOT NULL,
      merged_id VARCHAR(80) NOT NULL,
      plan_json JSON DEFAULT NULL,
      conflicts_json JSON DEFAULT NULL,
      merged_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_merge_entity (tenant_id, entity_type),
      KEY idx_merge_surviving (tenant_id, entity_type, surviving_id),
      KEY idx_merge_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}
