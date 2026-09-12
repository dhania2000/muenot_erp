-- ---------------------------------------------------------------------------
-- Upgrade & productionize HR → Shifts → Shift Assignments.
--
-- Additive and idempotent. Every statement is safe to re-run and preserves
-- existing hr_shift_assignments rows and their historical assignment_id values.
-- The application also applies these lazily via ensureShiftAssignmentSchema()
-- so a database that never runs this file still gets the columns/tables.
--
-- Idempotency note: plain `ALTER TABLE ... ADD COLUMN` / `CREATE INDEX` throw
-- (#1060 duplicate column, #1061 duplicate key) when the object already exists,
-- and `ADD COLUMN IF NOT EXISTS` is not portable across MySQL versions. So we
-- guard every additive change with a stored procedure that first checks
-- information_schema and only runs the DDL when the object is missing.
--
-- Shift Assignments is the authoritative employee->shift relationship. It never
-- stores employee, shift-policy, rotation or attendance data — those live in
-- their own masters and are only referenced here.
-- ---------------------------------------------------------------------------

-- --- Guarded DDL helpers ----------------------------------------------------

DROP PROCEDURE IF EXISTS __v0_add_column;
DROP PROCEDURE IF EXISTS __v0_add_index;

DELIMITER //

-- Add a column only when it does not already exist on the given table.
CREATE PROCEDURE __v0_add_column(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = p_table
       AND COLUMN_NAME = p_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //

-- Add an index only when an index of that name does not already exist.
CREATE PROCEDURE __v0_add_index(
  IN p_table VARCHAR(64),
  IN p_index VARCHAR(64),
  IN p_columns TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = p_table
       AND INDEX_NAME = p_index
  ) THEN
    SET @ddl = CONCAT('CREATE INDEX `', p_index, '` ON `', p_table, '` ', p_columns);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //

DELIMITER ;

-- --- Source tracking & lifecycle columns (§13, §60) -------------------------
-- change_type / source_request_id may already exist from the shift-change
-- migration; each call is a no-op if the column is present.
CALL __v0_add_column('hr_shift_assignments', 'source_type',        "VARCHAR(40) NOT NULL DEFAULT 'MANUAL'");
CALL __v0_add_column('hr_shift_assignments', 'source_id',          "VARCHAR(50) DEFAULT NULL");
CALL __v0_add_column('hr_shift_assignments', 'change_type',        "ENUM('Temporary','Permanent') NOT NULL DEFAULT 'Permanent'");
CALL __v0_add_column('hr_shift_assignments', 'source_request_id',  "VARCHAR(50) DEFAULT NULL");
CALL __v0_add_column('hr_shift_assignments', 'assigned_by_name',   "VARCHAR(150) DEFAULT NULL");
CALL __v0_add_column('hr_shift_assignments', 'ended_by',           "BIGINT UNSIGNED DEFAULT NULL");
CALL __v0_add_column('hr_shift_assignments', 'ended_at',           "DATETIME DEFAULT NULL");
CALL __v0_add_column('hr_shift_assignments', 'created_at',         "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
CALL __v0_add_column('hr_shift_assignments', 'updated_at',         "TIMESTAMP NULL DEFAULT NULL");

-- Backfill provenance for rows created before source tracking existed: anything
-- linked to a shift change request is SHIFT_CHANGE_REQUEST, everything else MANUAL.
UPDATE hr_shift_assignments
   SET source_type = 'SHIFT_CHANGE_REQUEST', source_id = source_request_id
 WHERE source_request_id IS NOT NULL AND (source_type IS NULL OR source_type = 'MANUAL');

-- --- Indexes for the hot resolver path and shift reports ---------------------
CALL __v0_add_index('hr_shift_assignments', 'idx_shift_assignment_emp_dates',   '(employee_id, effective_from, effective_to)');
CALL __v0_add_index('hr_shift_assignments', 'idx_shift_assignment_shift_dates', '(shift_id, effective_from, effective_to)');
CALL __v0_add_index('hr_shift_assignments', 'idx_shift_assignment_status',      '(status, effective_from)');

-- Helpers are one-shot; drop them so the schema stays clean.
DROP PROCEDURE IF EXISTS __v0_add_column;
DROP PROCEDURE IF EXISTS __v0_add_index;

-- --- Per-assignment audit trail (§35) ---------------------------------------
-- Mirrors hr_shift_events / hr_employee_events. CREATE TABLE IF NOT EXISTS is
-- natively idempotent.
CREATE TABLE IF NOT EXISTS hr_shift_assignment_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  assignment_id VARCHAR(50) NOT NULL,
  employee_id BIGINT UNSIGNED DEFAULT NULL,
  event_type VARCHAR(60) NOT NULL,
  summary VARCHAR(255) NOT NULL,
  changes JSON DEFAULT NULL,
  reason VARCHAR(500) DEFAULT NULL,
  actor_id BIGINT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(150) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_shift_assignment_event_ref (assignment_id, created_at),
  KEY idx_shift_assignment_event_emp (employee_id),
  KEY idx_shift_assignment_event_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- RBAC features for the module -------------------------------------------
-- Best-effort; INSERT IGNORE is idempotent and no-ops if modules/features differ.
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Manage Shift Assignments','hr.manage_shift_assignments','Create, edit and end shift assignments',21 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Override Shift Assignment Conflicts','hr.override_shift_assignments','Override overlapping/rotation assignment conflicts',22 FROM modules WHERE slug='hr';
