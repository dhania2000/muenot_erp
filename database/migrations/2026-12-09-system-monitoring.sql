-- Apply once with the existing migration workflow. No existing ERP tables are changed.
CREATE TABLE IF NOT EXISTS system_incidents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  environment VARCHAR(32) NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  service VARCHAR(80) NOT NULL,
  component VARCHAR(80) DEFAULT NULL,
  operation VARCHAR(80) DEFAULT NULL,
  error_code VARCHAR(100) DEFAULT NULL,
  severity VARCHAR(12) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  priority VARCHAR(2) NOT NULL DEFAULT 'P3',
  assigned_to INT UNSIGNED DEFAULT NULL,
  occurrence_count BIGINT UNSIGNED NOT NULL DEFAULT 1,
  affected_tenant_count INT UNSIGNED NOT NULL DEFAULT 0,
  latest_log_id BIGINT UNSIGNED DEFAULT NULL,
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_monitor_fingerprint (environment, fingerprint),
  KEY idx_monitor_incident_status (environment, status, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS system_incident_tenants (
  incident_id BIGINT UNSIGNED NOT NULL,
  tenant_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (incident_id, tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS system_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  environment VARCHAR(32) NOT NULL,
  severity VARCHAR(12) NOT NULL,
  service VARCHAR(80) NOT NULL,
  component VARCHAR(80) DEFAULT NULL,
  operation VARCHAR(80) DEFAULT NULL,
  event_type VARCHAR(80) DEFAULT NULL,
  error_code VARCHAR(100) DEFAULT NULL,
  message VARCHAR(1024) NOT NULL,
  tenant_id INT UNSIGNED DEFAULT NULL,
  user_id INT UNSIGNED DEFAULT NULL,
  route VARCHAR(255) DEFAULT NULL,
  method VARCHAR(12) DEFAULT NULL,
  http_status SMALLINT UNSIGNED DEFAULT NULL,
  request_id VARCHAR(100) DEFAULT NULL,
  correlation_id VARCHAR(100) DEFAULT NULL,
  trace_id VARCHAR(100) DEFAULT NULL,
  job_id VARCHAR(100) DEFAULT NULL,
  webhook_id VARCHAR(100) DEFAULT NULL,
  integration VARCHAR(80) DEFAULT NULL,
  duration_ms INT UNSIGNED DEFAULT NULL,
  source VARCHAR(80) DEFAULT NULL,
  release_id VARCHAR(100) DEFAULT NULL,
  metadata_json JSON DEFAULT NULL,
  stack_text TEXT DEFAULT NULL,
  fingerprint CHAR(64) DEFAULT NULL,
  incident_id BIGINT UNSIGNED DEFAULT NULL,
  KEY idx_monitor_time (created_at, id),
  KEY idx_monitor_severity (severity, created_at),
  KEY idx_monitor_service (service, created_at),
  KEY idx_monitor_code (error_code, created_at),
  KEY idx_monitor_tenant (tenant_id, created_at),
  KEY idx_monitor_request (request_id),
  KEY idx_monitor_correlation (correlation_id),
  KEY idx_monitor_incident (incident_id, created_at),
  KEY idx_monitor_environment (environment, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS system_incident_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  incident_id BIGINT UNSIGNED NOT NULL,
  actor_user_id INT UNSIGNED DEFAULT NULL,
  action VARCHAR(32) NOT NULL,
  note VARCHAR(1000) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_monitor_timeline (incident_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS system_alert_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  severity VARCHAR(12) NOT NULL DEFAULT 'ERROR',
  service VARCHAR(80) DEFAULT NULL,
  threshold_count INT UNSIGNED NOT NULL DEFAULT 1,
  window_minutes INT UNSIGNED NOT NULL DEFAULT 5,
  cooldown_minutes INT UNSIGNED NOT NULL DEFAULT 60,
  channel VARCHAR(20) NOT NULL DEFAULT 'in_app',
  last_fired_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_monitor_alert_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO system_alert_rules (name, severity, threshold_count, window_minutes, cooldown_minutes, channel)
VALUES ('Critical application incident', 'CRITICAL', 1, 5, 60, 'in_app');

CREATE TABLE IF NOT EXISTS system_alert_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rule_id BIGINT UNSIGNED NOT NULL,
  incident_id BIGINT UNSIGNED NOT NULL,
  channel VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  cooldown_bucket BIGINT UNSIGNED NOT NULL,
  safe_error VARCHAR(500) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_monitor_alert_cooldown (rule_id, incident_id, cooldown_bucket),
  KEY idx_monitor_alert_incident (incident_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS system_health_checks (
  name VARCHAR(80) NOT NULL PRIMARY KEY,
  status VARCHAR(12) NOT NULL,
  response_time_ms INT UNSIGNED DEFAULT NULL,
  safe_reason VARCHAR(500) DEFAULT NULL,
  last_checked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS system_monitor_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  min_severity VARCHAR(12) NOT NULL DEFAULT 'WARNING',
  debug_retention_days SMALLINT UNSIGNED NOT NULL DEFAULT 7,
  info_retention_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  warning_retention_days SMALLINT UNSIGNED NOT NULL DEFAULT 90,
  error_retention_days SMALLINT UNSIGNED NOT NULL DEFAULT 180,
  critical_retention_days SMALLINT UNSIGNED NOT NULL DEFAULT 365,
  slow_request_ms INT UNSIGNED NOT NULL DEFAULT 2000,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO system_monitor_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS system_monitor_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id INT UNSIGNED NOT NULL,
  action VARCHAR(60) NOT NULL,
  target_type VARCHAR(40) NOT NULL,
  target_id VARCHAR(100) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_monitor_audit_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
