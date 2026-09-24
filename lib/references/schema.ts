import "server-only"
/**
 * SPEC 93 — Reference Number Management schema (idempotent self-heal).
 * ---------------------------------------------------------------------------
 * Follows the same migration-runner-free pattern as the rest of the codebase:
 * every statement is CREATE TABLE IF NOT EXISTS, safe to run on every request
 * and against a live production database.
 *
 * Two tenant-owned tables (registered in lib/tenant-tables.ts):
 *   - reference_configs    : per-tenant, per-(document type, reference type)
 *                            configuration — enabled, required, duplicate policy.
 *   - document_references  : the actual reference values attached to documents.
 *                            The UNIQUE key (tenant, doc type, doc id, ref type)
 *                            means each document holds one value per reference
 *                            type; the (tenant, doc type, ref type, normalized)
 *                            index powers duplicate detection.
 */
import { query } from "@/lib/db"

let ensured: Promise<void> | null = null

export function ensureReferenceSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS reference_configs (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      document_type VARCHAR(40) NOT NULL,
      ref_type VARCHAR(20) NOT NULL,
      enabled TINYINT NOT NULL DEFAULT 1,
      required TINYINT NOT NULL DEFAULT 0,
      duplicate_policy VARCHAR(10) NOT NULL DEFAULT 'off',
      updated_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_reference_config (tenant_id, document_type, ref_type),
      KEY idx_reference_config_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS document_references (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      document_type VARCHAR(40) NOT NULL,
      document_id VARCHAR(80) NOT NULL,
      ref_type VARCHAR(20) NOT NULL,
      ref_value VARCHAR(120) NOT NULL,
      normalized VARCHAR(120) NOT NULL,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_document_reference (tenant_id, document_type, document_id, ref_type),
      KEY idx_document_reference_dup (tenant_id, document_type, ref_type, normalized),
      KEY idx_document_reference_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}
