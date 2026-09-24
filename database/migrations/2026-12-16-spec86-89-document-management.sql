-- =============================================================
-- SPEC 86 — Document Management System
-- SPEC 87 — Document Approval
-- SPEC 88 — Document Expiry
-- SPEC 89 — Document Sharing
-- =============================================================
-- Canonical schema for the enterprise Document Management System. Every table
-- here is otherwise self-healed at runtime by `ensureDmsSchema()` in
-- lib/dms/schema.ts (CREATE TABLE IF NOT EXISTS + addColumnIfMissing). This
-- migration documents the canonical shape and lets a fresh database be
-- provisioned up front.
--
-- The DMS is a business layer over the existing `file_objects` store (the raw
-- bytes, versioning, integrity, retention and quotas live there). These tables
-- add the enterprise document model: folders, categories, tags, per-subject
-- permissions, share links, approval workflow and an audit trail.
--
-- All tables carry `tenant_id` and are registered in lib/tenant-tables.ts, so
-- the fail-closed guard and the tenant-scoped helpers enforce isolation on
-- every read/write.
--
-- Idempotent: safe to run repeatedly and safe to run after runtime auto-heal.
-- =============================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- -------------------------------------------------------------
-- SPEC 86 — Folders
-- -------------------------------------------------------------
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 86 — Categories
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dms_categories (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  color VARCHAR(20) DEFAULT NULL,
  description VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dms_cat_tenant_name (tenant_id, name),
  KEY idx_dms_cat_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 86 — Tags
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dms_tags (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  name VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dms_tag_tenant_name (tenant_id, name),
  KEY idx_dms_tag_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 86 — Documents (with SPEC 87 approval + SPEC 88 expiry columns folded in)
-- -------------------------------------------------------------
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
  -- SPEC 87 — configurable approval workflow linkage
  workflow_type VARCHAR(40) DEFAULT NULL,
  approval_request_id BIGINT DEFAULT NULL,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 86 — Document ↔ Tag join
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dms_document_tags (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  tag_id BIGINT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dms_doctag (tenant_id, document_id, tag_id),
  KEY idx_dms_doctag_tenant (tenant_id),
  KEY idx_dms_doctag_tag (tenant_id, tag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 86 — Per-subject permissions (document- or folder-scoped)
-- -------------------------------------------------------------
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 89 — Secure share links (view-only, password, download caps, expiry)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dms_document_shares (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  token VARCHAR(64) NOT NULL,
  access VARCHAR(12) NOT NULL DEFAULT 'view',
  expires_at DATETIME DEFAULT NULL,
  revoked_at DATETIME DEFAULT NULL,
  download_count INT NOT NULL DEFAULT 0,
  -- SPEC 89 — secure sharing controls
  recipient_type VARCHAR(12) NOT NULL DEFAULT 'link',
  recipient VARCHAR(255) DEFAULT NULL,
  label VARCHAR(200) DEFAULT NULL,
  password_hash VARCHAR(255) DEFAULT NULL,
  max_downloads INT DEFAULT NULL,
  view_count INT NOT NULL DEFAULT 0,
  last_accessed_at DATETIME DEFAULT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dms_share_token (token),
  KEY idx_dms_share_tenant (tenant_id),
  KEY idx_dms_share_doc (tenant_id, document_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 86 — Audit trail (with SPEC 89 per-share-link linkage)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dms_audit (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  document_id BIGINT DEFAULT NULL,
  action VARCHAR(40) NOT NULL,
  detail VARCHAR(1000) DEFAULT NULL,
  user_id INT DEFAULT NULL,
  -- SPEC 89 — tie audit rows to a share link so per-link access history is queryable
  share_id BIGINT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_dms_audit_tenant (tenant_id),
  KEY idx_dms_audit_doc (tenant_id, document_id),
  KEY idx_dms_audit_created (tenant_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
