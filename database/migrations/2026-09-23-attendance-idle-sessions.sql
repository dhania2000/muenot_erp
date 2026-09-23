-- Idempotent continuous inactivity intervals for the existing hr_attendance row.
-- Each interval receives its own grace period; heartbeat retries update end_ms.
SET @auto_break_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'hr_attendance' AND column_name = 'auto_break_seconds'
);
SET @auto_break_sql = IF(@auto_break_exists = 0,
  'ALTER TABLE hr_attendance ADD COLUMN auto_break_seconds INT UNSIGNED NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE auto_break_stmt FROM @auto_break_sql;
EXECUTE auto_break_stmt;
DEALLOCATE PREPARE auto_break_stmt;

CREATE TABLE IF NOT EXISTS hr_attendance_idle_sessions (
  tenant_id INT UNSIGNED NOT NULL,
  attendance_row_id BIGINT UNSIGNED NOT NULL,
  session_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  start_ms BIGINT UNSIGNED NOT NULL,
  end_ms BIGINT UNSIGNED NOT NULL,
  ended TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id,attendance_row_id,session_key),
  KEY idx_attendance_idle_row (attendance_row_id),
  CONSTRAINT fk_attendance_idle_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_attendance_idle_attendance FOREIGN KEY (attendance_row_id) REFERENCES hr_attendance(id) ON DELETE CASCADE,
  CONSTRAINT ck_attendance_idle_range CHECK (end_ms >= start_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
