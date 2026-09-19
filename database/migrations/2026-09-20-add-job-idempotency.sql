-- Receipt is committed in the same InnoDB transaction as business effects.
CREATE TABLE IF NOT EXISTS platform_job_receipts (
  operation_key CHAR(64) PRIMARY KEY,
  request_hash CHAR(64) NOT NULL,
  execution_id CHAR(36) NOT NULL,
  result JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_job_execution (execution_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
