import "server-only"
/**
 * SPEC 19 (req #74) — AI Document Intelligence schema (runtime self-heal).
 * ---------------------------------------------------------------------------
 * Mirrors the DMS / file-security pattern: tables are created idempotently at
 * first use so the feature works whether or not the migration has been applied.
 * The canonical DDL also lives in database/migrations for a normal deploy.
 *
 * Tables (all tenant-scoped and registered in lib/tenant-tables.ts):
 *   - ai_document_extractions        one extraction job per raw document
 *   - ai_document_extraction_versions  immutable snapshot per extraction version
 *   - ai_document_extraction_audit   append-only audit trail
 */

import { query } from "@/lib/db"

let ensured: Promise<void> | null = null

export function ensureDocIntelligenceSchema(): Promise<void> {
  if (!ensured) ensured = build()
  return ensured
}

async function build(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS ai_document_extractions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT NOT NULL,
      file_id BIGINT NOT NULL,
      file_ref VARCHAR(120) NULL,
      dms_document_id BIGINT NULL,
      doc_type VARCHAR(20) NOT NULL DEFAULT 'unknown',
      status VARCHAR(20) NOT NULL DEFAULT 'uploaded',
      extraction_version INT NOT NULL DEFAULT 0,
      provider VARCHAR(60) NULL,
      model_id VARCHAR(120) NULL,
      language VARCHAR(20) NULL,
      overall_confidence DECIMAL(5,4) NOT NULL DEFAULT 0,
      fields_json JSON NULL,
      highlights_json JSON NULL,
      warnings_json JSON NULL,
      content_hash VARCHAR(64) NOT NULL,
      post_idempotency_key VARCHAR(120) NULL,
      posted_entity_type VARCHAR(80) NULL,
      posted_entity_id VARCHAR(120) NULL,
      reviewed_by INT NULL,
      reviewed_at DATETIME NULL,
      posted_by INT NULL,
      posted_at DATETIME NULL,
      error VARCHAR(1000) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ai_doc_extraction_content (tenant_id, content_hash),
      KEY idx_ai_doc_extraction_tenant_status (tenant_id, status),
      KEY idx_ai_doc_extraction_file (tenant_id, file_id),
      KEY idx_ai_doc_extraction_type (tenant_id, doc_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS ai_document_extraction_versions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT NOT NULL,
      extraction_id BIGINT UNSIGNED NOT NULL,
      version INT NOT NULL,
      doc_type VARCHAR(20) NOT NULL,
      provider VARCHAR(60) NULL,
      model_id VARCHAR(120) NULL,
      overall_confidence DECIMAL(5,4) NOT NULL DEFAULT 0,
      fields_json JSON NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_ai_doc_version (tenant_id, extraction_id, version),
      KEY idx_ai_doc_version_extraction (tenant_id, extraction_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS ai_document_extraction_audit (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT NOT NULL,
      extraction_id BIGINT UNSIGNED NOT NULL,
      action VARCHAR(40) NOT NULL,
      detail VARCHAR(1000) NULL,
      from_version INT NULL,
      to_version INT NULL,
      user_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ai_doc_audit_extraction (tenant_id, extraction_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}
