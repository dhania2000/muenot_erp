import "server-only"
/**
 * SPEC 94 — Custom Fields schema (idempotent self-heal).
 * ---------------------------------------------------------------------------
 * Same migration-runner-free pattern as the rest of the codebase: every
 * statement is CREATE TABLE IF NOT EXISTS, safe to run on every request and
 * against a live production database.
 *
 * Two tenant-owned tables (registered in lib/tenant-tables.ts):
 *   - custom_field_defs   : the metadata for each tenant-defined field — its
 *                           type, options, config, permissions and ordering.
 *                           UNIQUE (tenant, entity_type, field_key).
 *   - custom_field_values : the value each field holds for a given record.
 *                           UNIQUE (tenant, entity_type, record_id, field_key);
 *                           the (tenant, entity_type, record_id) index loads a
 *                           whole record's custom values in one scan.
 */
import { query } from "@/lib/db"

let ensured: Promise<void> | null = null

export function ensureCustomFieldSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS custom_field_defs (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      entity_type VARCHAR(40) NOT NULL,
      field_key VARCHAR(60) NOT NULL,
      label VARCHAR(120) NOT NULL,
      field_type VARCHAR(20) NOT NULL,
      required TINYINT NOT NULL DEFAULT 0,
      options_json JSON DEFAULT NULL,
      config_json JSON DEFAULT NULL,
      default_json JSON DEFAULT NULL,
      help_text VARCHAR(500) NOT NULL DEFAULT '',
      view_min_role VARCHAR(20) NOT NULL DEFAULT 'employee',
      edit_min_role VARCHAR(20) NOT NULL DEFAULT 'employee',
      active TINYINT NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_custom_field_def (tenant_id, entity_type, field_key),
      KEY idx_custom_field_def_entity (tenant_id, entity_type),
      KEY idx_custom_field_def_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS custom_field_values (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      entity_type VARCHAR(40) NOT NULL,
      record_id VARCHAR(80) NOT NULL,
      field_key VARCHAR(60) NOT NULL,
      value_json JSON DEFAULT NULL,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_custom_field_value (tenant_id, entity_type, record_id, field_key),
      KEY idx_custom_field_value_record (tenant_id, entity_type, record_id),
      KEY idx_custom_field_value_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}
