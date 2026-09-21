-- SPEC 50: centralized, tenant-scoped email engine. Transport secrets remain in
-- the existing encrypted environment-variable store; this migration stores no secrets.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS tenant_email_senders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
  module VARCHAR(30) NOT NULL, from_name VARCHAR(120) NULL, from_address VARCHAR(190) NULL,
  reply_to VARCHAR(190) NULL, transport_department VARCHAR(30) NOT NULL DEFAULT 'sales', enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tenant_email_sender (tenant_id,module), KEY idx_tenant_email_sender (tenant_id,enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tenant_email_templates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL, module VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL, template_key VARCHAR(120) NULL, subject VARCHAR(255) NOT NULL, html MEDIUMTEXT NOT NULL,
  variables_json JSON NULL, status VARCHAR(20) NOT NULL DEFAULT 'draft', version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tenant_email_template_key (tenant_id,module,template_key), KEY idx_tenant_email_templates (tenant_id,module,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tenant_email_messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL, module VARCHAR(30) NOT NULL,
  template_id BIGINT UNSIGNED NULL, sender_id BIGINT UNSIGNED NULL, to_email VARCHAR(190) NOT NULL, to_name VARCHAR(190) NULL,
  subject VARCHAR(255) NOT NULL, html MEDIUMTEXT NOT NULL, thread_key VARCHAR(160) NOT NULL, in_reply_to_message_id BIGINT UNSIGNED NULL,
  message_id VARCHAR(255) NULL, provider_thread_id VARCHAR(190) NULL, references_header TEXT NULL, attachments_json JSON NULL,
  tracking_token VARCHAR(64) NULL, tracking_consent BOOLEAN NOT NULL DEFAULT FALSE,
  status ENUM('queued','sending','accepted','delivered','bounced','failed','cancelled') NOT NULL DEFAULT 'queued', attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  job_id BIGINT UNSIGNED NULL, provider_message_id VARCHAR(255) NULL, last_error VARCHAR(1000) NULL,
  sent_by BIGINT UNSIGNED NULL, accepted_at DATETIME NULL, delivered_at DATETIME NULL, opened_at DATETIME NULL, open_count INT UNSIGNED NOT NULL DEFAULT 0,
  clicked_at DATETIME NULL, click_count INT UNSIGNED NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tenant_email_tracking (tracking_token), KEY idx_tenant_email_messages (tenant_id,status,created_at), KEY idx_tenant_email_thread (tenant_id,thread_key,created_at), KEY idx_tenant_email_job (job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tenant_email_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL, message_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(30) NOT NULL, detail JSON NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tenant_email_events (tenant_id,message_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
