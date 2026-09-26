-- Spec43 follow-up — indexes for the tenant-scoped risk & compliance probes.
-- Idempotent: each index is created only when its table exists and the index
-- does not (MySQL has no CREATE INDEX IF NOT EXISTS).
-- The permission scope itself needs no schema: grants for the new
-- `risk.compliance` domain are stored in the existing data-scope grants table.

DROP PROCEDURE IF EXISTS spec43_add_index;
DELIMITER //
CREATE PROCEDURE spec43_add_index(IN t VARCHAR(64), IN i VARCHAR(64), IN cols VARCHAR(255))
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t)
     AND NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND INDEX_NAME = i) THEN
    SET @ddl = CONCAT('CREATE INDEX `', i, '` ON `', t, '` (', cols, ')');
    PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END //
DELIMITER ;

CALL spec43_add_index('audit_log_entries', 'idx_rc_auth_failures', '`tenant_id`, `result`, `created_at`');
CALL spec43_add_index('approval_requests', 'idx_rc_pending', '`tenant_id`, `status`, `created_at`');
CALL spec43_add_index('platform_background_jobs', 'idx_rc_failed_jobs', '`tenant_id`, `status`, `updated_at`');
CALL spec43_add_index('training_assignments', 'idx_rc_overdue', '`tenant_id`, `status`, `due_date`');

DROP PROCEDURE IF EXISTS spec43_add_index;
