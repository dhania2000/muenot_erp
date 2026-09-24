import "server-only"
/**
 * SPEC 92 — Numbering Engine schema (idempotent self-heal).
 * ---------------------------------------------------------------------------
 * Follows the same migration-runner-free pattern as the rest of the codebase:
 * every statement is CREATE TABLE IF NOT EXISTS, safe to run on every request
 * and against a live production database.
 *
 * Two tenant-owned tables (registered in lib/tenant-tables.ts):
 *   - numbering_rules    : the per-tenant, per-entity format + reset config.
 *   - numbering_counters : the running sequence per (tenant, entity, period).
 *                          The UNIQUE key + atomic upsert on this table is what
 *                          makes concurrent allocation duplicate-free.
 *
 * This is a NEW, opt-in counter store. The legacy `record_id_sequences` table
 * (lib/record-ids.ts) is left untouched; a module only draws from the engine
 * once a tenant explicitly configures a rule for its entity, so existing id
 * streams are never disturbed.
 */
import { query } from "@/lib/db"

let ensured: Promise<void> | null = null

export function ensureNumberingSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure(): Promise<void> {
  await query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}
