-- Phase 1: additive Shopkeeper/mobile foundation. Existing tenants default to ENTERPRISE.
-- The runtime service can create this column first, so keep the migration safe
-- when it is applied afterwards on a live database.
DELIMITER $$
DROP PROCEDURE IF EXISTS __shopkeeper_add_tenant_type $$
CREATE PROCEDURE __shopkeeper_add_tenant_type()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='tenants' AND column_name='tenant_type') THEN
    ALTER TABLE tenants ADD COLUMN tenant_type VARCHAR(20) NOT NULL DEFAULT 'ENTERPRISE' AFTER status;
  END IF;
END $$
CALL __shopkeeper_add_tenant_type() $$
DROP PROCEDURE __shopkeeper_add_tenant_type $$
DELIMITER ;

CREATE TABLE IF NOT EXISTS shopkeeper_profiles (
  tenant_id INT UNSIGNED NOT NULL, shop_name VARCHAR(150) NOT NULL, owner_name VARCHAR(150) NULL,
  business_category VARCHAR(120) NULL, email VARCHAR(190) NULL, phone VARCHAR(40) NULL, address VARCHAR(500) NULL,
  city VARCHAR(120) NULL, state VARCHAR(120) NULL, pin_code VARCHAR(20) NULL, country VARCHAR(120) NULL,
  logo_url VARCHAR(500) NULL, business_hours JSON NULL, timezone VARCHAR(80) NULL, currency VARCHAR(12) NULL,
  gstin VARCHAR(32) NULL, website VARCHAR(255) NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id), CONSTRAINT fk_shopkeeper_profile_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mobile_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, session_id VARCHAR(64) NOT NULL, tenant_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL, refresh_token_hash CHAR(64) NOT NULL, device_name VARCHAR(120) NULL, platform VARCHAR(32) NULL,
  push_token_hash CHAR(64) NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL, revoked_at DATETIME NULL, revoked_reason VARCHAR(60) NULL, PRIMARY KEY(id),
  UNIQUE KEY uq_mobile_session(session_id), UNIQUE KEY uq_mobile_refresh(refresh_token_hash), KEY idx_mobile_sessions_user(user_id,tenant_id),
  CONSTRAINT fk_mobile_session_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_session_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mobile_device_registrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
  mobile_session_id VARCHAR(64) NOT NULL, provider VARCHAR(20) NOT NULL DEFAULT 'fcm', token_hash CHAR(64) NOT NULL, token_encrypted TEXT NOT NULL,
  device_name VARCHAR(120) NULL, platform VARCHAR(32) NULL, enabled TINYINT(1) NOT NULL DEFAULT 1, last_seen_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_mobile_device_token(tenant_id,token_hash), KEY idx_mobile_device_user(tenant_id,user_id),
  CONSTRAINT fk_mobile_device_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mobile_api_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
  session_id VARCHAR(64) NULL, action VARCHAR(80) NOT NULL, method VARCHAR(12) NULL, path VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(id),
  KEY idx_mobile_audit_tenant(tenant_id,created_at), KEY idx_mobile_audit_user(user_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
