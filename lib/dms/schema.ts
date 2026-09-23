import "server-only"
/**
 * SPEC 86 — Document Management System schema (idempotent self-heal).
 * ---------------------------------------------------------------------------
 * The DMS is a business layer over the existing `file_objects` store: the raw
 * bytes, versioning, integrity, retention and quotas already live there. These
 * tables add the enterprise document model on top — folders, categories, tags,
 * per-subject permissions, share links, approval workflow and an audit trail.
 *
 * Every table carries `tenant_id` and is registered in lib/tenant-tables.ts so
 * the fail-closed guard and the tenant-scoped helpers enforce isolation.
 */
import { query } from "@/lib/db"

let ensured: Promise<void> | null = null

/** Idempotently create all DMS tables + indexes. Safe to call on every request. */
export function ensureDmsSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

/** Add a column to an existing table only when it is not already present. */
async function addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
  const rows = await query<any[]>(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  if (Number(rows?.[0]?.n ?? 0) > 0) return
  await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
}

async function doEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS dms_folders (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      name VARCHAR(255) NOT NULL,
      parent_id BIGINT DEFAULT NULL,
      owner_id INT DEFAULT NULL,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_dms_folders_tenant (tenant_id),
      KEY idx_dms_folders_parent (tenant_id, parent_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS dms_categories (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      name VARCHAR(120) NOT NULL,
      color VARCHAR(20) DEFAULT NULL,
      description VARCHAR(500) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dms_cat_tenant_name (tenant_id, name),
      KEY idx_dms_cat_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS dms_tags (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      name VARCHAR(80) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dms_tag_tenant_name (tenant_id, name),
      KEY idx_dms_tag_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS dms_documents (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      title VARCHAR(300) NOT NULL,
      description TEXT DEFAULT NULL,
      folder_id BIGINT DEFAULT NULL,
      category_id BIGINT DEFAULT NULL,
      owner_id INT DEFAULT NULL,
      file_id BIGINT DEFAULT NULL,
      source_module VARCHAR(60) DEFAULT NULL,
      source_entity_type VARCHAR(80) DEFAULT NULL,
      source_entity_id VARCHAR(120) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      approval_status VARCHAR(20) NOT NULL DEFAULT 'none',
      approved_by INT DEFAULT NULL,
      approved_at DATETIME DEFAULT NULL,
      expires_at DATETIME DEFAULT NULL,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME DEFAULT NULL,
      deleted_by INT DEFAULT NULL,
      KEY idx_dms_doc_tenant (tenant_id),
      KEY idx_dms_doc_folder (tenant_id, folder_id),
      KEY idx_dms_doc_category (tenant_id, category_id),
      KEY idx_dms_doc_owner (tenant_id, owner_id),
      KEY idx_dms_doc_status (tenant_id, status),
      KEY idx_dms_doc_source (tenant_id, source_module, source_entity_type, source_entity_id),
      KEY idx_dms_doc_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // SPEC 87 — link a document to its configurable approval workflow + the
  // approval-authority request currently governing it. Added idempotently so
  // pre-SPEC-87 deployments self-heal on the next request.
  await addColumnIfMissing("dms_documents", "workflow_type", "VARCHAR(40) DEFAULT NULL")
  await addColumnIfMissing("dms_documents", "approval_request_id", "BIGINT DEFAULT NULL")

  await query(`
    CREATE TABLE IF NOT EXISTS dms_document_tags (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      document_id BIGINT NOT NULL,
      tag_id BIGINT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dms_doctag (tenant_id, document_id, tag_id),
      KEY idx_dms_doctag_tenant (tenant_id),
      KEY idx_dms_doctag_tag (tenant_id, tag_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS dms_document_permissions (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      document_id BIGINT DEFAULT NULL,
      folder_id BIGINT DEFAULT NULL,
      subject_type VARCHAR(10) NOT NULL,
      subject_id VARCHAR(120) NOT NULL,
      access_level VARCHAR(12) NOT NULL DEFAULT 'view',
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_dms_perm_tenant (tenant_id),
      KEY idx_dms_perm_doc (tenant_id, document_id),
      KEY idx_dms_perm_folder (tenant_id, folder_id),
      KEY idx_dms_perm_subject (tenant_id, subject_type, subject_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS dms_document_shares (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      document_id BIGINT NOT NULL,
      token VARCHAR(64) NOT NULL,
      access VARCHAR(12) NOT NULL DEFAULT 'view',
      expires_at DATETIME DEFAULT NULL,
      revoked_at DATETIME DEFAULT NULL,
      download_count INT NOT NULL DEFAULT 0,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dms_share_token (token),
      KEY idx_dms_share_tenant (tenant_id),
      KEY idx_dms_share_doc (tenant_id, document_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS dms_audit (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      document_id BIGINT DEFAULT NULL,
      action VARCHAR(40) NOT NULL,
      detail VARCHAR(1000) DEFAULT NULL,
      user_id INT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_dms_audit_tenant (tenant_id),
      KEY idx_dms_audit_doc (tenant_id, document_id),
      KEY idx_dms_audit_created (tenant_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}
