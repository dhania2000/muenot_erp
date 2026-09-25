-- =============================================================
-- Spec7 — Customer-owned S3 IAM access (requirements #14-15)
-- =============================================================
-- Adds IAM-role / temporary-credential support and pre-activation
-- verification metadata to the customer storage connection registry, plus the
-- direct-to-bucket (presigned PUT) upload-intent table used for idempotent
-- server-authorized uploads.
--
-- Every column here is also self-healed at runtime by
-- lib/storage/connection-store.ts (ensureStorageSchema / IAM_COLUMNS /
-- ensureUploadIntentSchema); this migration documents the canonical shape and
-- lets a fresh database be provisioned up front.
--
-- All tables are tenant-owned and accessed only through the tenant-scope
-- helpers, so every read/write is isolated per tenant. Secrets (secret access
-- key, session token) are encrypted at rest; the ExternalId is platform-minted
-- per connection for confused-deputy protection.
--
-- Idempotent: safe to run repeatedly and safe to run after runtime auto-heal.
-- =============================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- -------------------------------------------------------------
-- Credential strategy + verification columns on the connection registry
-- -------------------------------------------------------------
-- Credential strategy: 'access_key' (long-lived key pair, default),
-- 'temporary' (key + secret + session token) or 'iam_role' (cross-account
-- AssumeRole, AWS S3 only).
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS auth_mode VARCHAR(20) NOT NULL DEFAULT 'access_key';

-- Temporary-credential material + expiry (STS session token).
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS session_token TEXT DEFAULT NULL;
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS credential_expires_at DATETIME DEFAULT NULL;

-- Cross-account IAM role: the ARN we assume, the platform-minted ExternalId
-- pinned in its trust policy, and the AWS account expected to own the bucket.
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS role_arn VARCHAR(2048) DEFAULT NULL;
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS external_id VARCHAR(255) DEFAULT NULL;
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS expected_bucket_owner VARCHAR(12) DEFAULT NULL;

-- Pre-activation verification: a connection may only be activated once it has
-- been verified against its CURRENT configuration (fingerprint match).
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) NOT NULL DEFAULT 'unverified';
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS verified_fingerprint CHAR(64) DEFAULT NULL;
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS verified_at DATETIME DEFAULT NULL;
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS verification_detail VARCHAR(500) DEFAULT NULL;

-- Revocation: destroys stored secrets and takes the connection permanently
-- offline (create a new connection to reconnect).
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS revoked_at DATETIME DEFAULT NULL;
ALTER TABLE tenant_storage_connections
  ADD COLUMN IF NOT EXISTS revoked_by INT DEFAULT NULL;

-- -------------------------------------------------------------
-- Direct-to-bucket presigned upload intents (idempotent per tenant + key)
-- -------------------------------------------------------------
-- Each row records a server-authorized presigned PUT: the exact object key,
-- declared size/type and the request fingerprint. A replay with the same
-- idempotency key and body re-issues the SAME key; a different body is a 409.
-- Completion HEADs the object and checks the size before recording the file.
CREATE TABLE IF NOT EXISTS storage_upload_intents (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_fingerprint VARCHAR(700) NOT NULL,
  connection_id BIGINT DEFAULT NULL,
  provider VARCHAR(40) NOT NULL,
  object_key VARCHAR(1024) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(190) NOT NULL,
  declared_size BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  file_object_id BIGINT DEFAULT NULL,
  created_by INT DEFAULT NULL,
  expires_at DATETIME NOT NULL,
  completed_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sui_tenant_key (tenant_id, idempotency_key),
  KEY idx_sui_tenant_status (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
