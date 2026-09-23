-- : shared, atomic API rate counters for deployments with multiple Node workers.
CREATE TABLE IF NOT EXISTS api_rate_limit_counters (
  tenant_id INT UNSIGNED NOT NULL,
  scope_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  window_name VARCHAR(8) NOT NULL,
  window_start_ms BIGINT UNSIGNED NOT NULL,
  reset_at_ms BIGINT UNSIGNED NOT NULL,
  request_count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, scope_hash, window_name, window_start_ms),
  KEY idx_api_rate_counter_expiry (reset_at_ms),
  CONSTRAINT fk_api_rate_counter_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_rate_limit_abuse (
  tenant_id INT UNSIGNED NOT NULL,
  scope_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  strikes INT UNSIGNED NOT NULL DEFAULT 0,
  window_reset_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
  blocked_until_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, scope_hash),
  KEY idx_api_rate_abuse_expiry (blocked_until_ms, window_reset_ms),
  CONSTRAINT fk_api_rate_abuse_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_rate_limit_policies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  target_type ENUM('tenant','api_key','endpoint') NOT NULL,
  target_value VARCHAR(255) NOT NULL DEFAULT '',
  second_limit INT UNSIGNED NOT NULL,
  minute_limit INT UNSIGNED NOT NULL,
  hour_limit INT UNSIGNED NOT NULL,
  day_limit INT UNSIGNED NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_rate_policy_name (tenant_id,name),
  KEY idx_api_rate_policy_match (tenant_id,enabled,target_type,target_value),
  CONSTRAINT fk_api_rate_policy_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_api_rate_policy_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_api_rate_policy_editor FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_api_rate_policy_limits CHECK (second_limit > 0 AND minute_limit > 0 AND hour_limit > 0 AND day_limit > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
