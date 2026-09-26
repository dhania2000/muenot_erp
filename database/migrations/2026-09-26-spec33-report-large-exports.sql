-- SPEC 33 — Custom report builder: queued large exports (#70, #97)
-- ---------------------------------------------------------------------------
-- Backs the large-export queue. A tenant admin queues a report; a worker
-- streams it to private file storage in bounded pages, notifies the requester
-- and expires the artifact by policy. Every row is tenant-scoped and the
-- download link is an HMAC-signed, expiring URL (token_salt) — never a public
-- blob URL. The application self-heals this schema at runtime
-- (lib/reports/large-export-store.ts#ensureLargeExportSchema); this file is the
-- durable record of the change.

CREATE TABLE IF NOT EXISTS report_export_jobs (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       INT UNSIGNED NULL,
  report_id       INT UNSIGNED NULL,
  report_name     VARCHAR(190) NOT NULL,
  source_key      VARCHAR(120) NOT NULL,
  definition      JSON NOT NULL,
  format          VARCHAR(12) NOT NULL DEFAULT 'csv',
  status          VARCHAR(16) NOT NULL DEFAULT 'queued',
  row_count       INT UNSIGNED NOT NULL DEFAULT 0,
  byte_size       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  file_key        VARCHAR(400) NULL,
  file_name       VARCHAR(190) NULL,
  content_type    VARCHAR(120) NULL,
  storage_provider VARCHAR(40) NULL,
  token_salt      VARCHAR(64) NULL,
  requested_by    INT UNSIGNED NULL,
  request_key     VARCHAR(120) NULL,
  error           TEXT NULL,
  redacted_fields TEXT NULL,
  cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
  expires_at      TIMESTAMP NULL DEFAULT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at      TIMESTAMP NULL DEFAULT NULL,
  finished_at     TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_export_request (tenant_id, request_key),
  KEY idx_export_tenant (tenant_id, created_at),
  KEY idx_export_status (status),
  KEY idx_export_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
