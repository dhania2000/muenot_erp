-- ---------------------------------------------------------------------------
-- Upgrade & productionize HR → Shifts → Shift Assignments.
--
-- Additive and idempotent. Every statement is safe to re-run and preserves
-- existing hr_shift_assignments rows and their historical assignment_id values.
-- The application also applies these lazily via ensureShiftAssignmentSchema()
-- so a database that never runs this file still gets the columns/tables.
--
-- Shift Assignments is the authoritative employee->shift relationship. It never
-- stores employee, shift-policy, rotation or attendance data — those live in
-- their own masters and are only referenced here.
-- ---------------------------------------------------------------------------

-- Source tracking (§13, §60). change_type / source_request_id were already
-- added by the shift-change migration; these complete the provenance picture.
ALTER TABLE hr_shift_assignments ADD COLUMN `source_type` VARCHAR(40) NOT NULL DEFAULT 'MANUAL';
ALTER TABLE hr_shift_assignments ADD COLUMN `source_id` VARCHAR(50) DEFAULT NULL;
ALTER TABLE hr_shift_assignments ADD COLUMN `change_type` ENUM('Temporary','Permanent') NOT NULL DEFAULT 'Permanent';
ALTER TABLE hr_shift_assignments ADD COLUMN `source_request_id` VARCHAR(50) DEFAULT NULL;
ALTER TABLE hr_shift_assignments ADD COLUMN `assigned_by_name` VARCHAR(150) DEFAULT NULL;
ALTER TABLE hr_shift_assignments ADD COLUMN `ended_by` BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE hr_shift_assignments ADD COLUMN `ended_at` DATETIME DEFAULT NULL;
ALTER TABLE hr_shift_assignments ADD COLUMN `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE hr_shift_assignments ADD COLUMN `updated_at` TIMESTAMP NULL DEFAULT NULL;

-- Backfill provenance for rows created before source tracking existed: anything
-- linked to a shift change request is SHIFT_CHANGE_REQUEST, everything else MANUAL.
UPDATE hr_shift_assignments
   SET source_type = 'SHIFT_CHANGE_REQUEST', source_id = source_request_id
 WHERE source_request_id IS NOT NULL AND (source_type IS NULL OR source_type = 'MANUAL');

-- Indexes for the hot resolver path (employee + date range) and shift reports.
CREATE INDEX idx_shift_assignment_emp_dates ON hr_shift_assignments (employee_id, effective_from, effective_to);
CREATE INDEX idx_shift_assignment_shift_dates ON hr_shift_assignments (shift_id, effective_from, effective_to);
CREATE INDEX idx_shift_assignment_status ON hr_shift_assignments (status, effective_from);

-- Per-assignment audit trail (§35). Mirrors hr_shift_events / hr_employee_events.
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

-- RBAC features for the module (best-effort; ignored if modules/features differ).
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Manage Shift Assignments','hr.manage_shift_assignments','Create, edit and end shift assignments',21 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Override Shift Assignment Conflicts','hr.override_shift_assignments','Override overlapping/rotation assignment conflicts',22 FROM modules WHERE slug='hr';
