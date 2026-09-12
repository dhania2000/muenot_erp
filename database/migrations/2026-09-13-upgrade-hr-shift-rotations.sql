-- Productionise Shift Rotations. Additive & idempotent — mirrors the runtime
-- schema-ensure in lib/hr-shift-rotations.ts so the feature works before this
-- file is applied by hand. Every new column is nullable / defaulted so legacy
-- rows created by the old generic form keep resolving.

-- Rotation header: business code, effective window, ownership + audit stamps,
-- timezone and a pointer to the current pattern version.
ALTER TABLE hr_shift_rotations ADD COLUMN rotation_code VARCHAR(40) DEFAULT NULL;
ALTER TABLE hr_shift_rotations ADD COLUMN effective_from DATE DEFAULT NULL;
ALTER TABLE hr_shift_rotations ADD COLUMN effective_until DATE DEFAULT NULL;
ALTER TABLE hr_shift_rotations ADD COLUMN time_zone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE hr_shift_rotations ADD COLUMN current_version_no INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE hr_shift_rotations ADD COLUMN created_by_name VARCHAR(150) DEFAULT NULL;
ALTER TABLE hr_shift_rotations ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL;

-- Effective-dated pattern versions. Editing a running rotation's pattern never
-- rewrites history — it creates a new version with a future effective_from.
CREATE TABLE IF NOT EXISTS hr_shift_rotation_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_id VARCHAR(50) NOT NULL,
  rotation_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  effective_from DATE NOT NULL,
  cycle_type ENUM('Days','Weeks','Months') NOT NULL DEFAULT 'Weeks',
  cycle_length INT UNSIGNED NOT NULL DEFAULT 1,
  notes VARCHAR(500) DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_by_name VARCHAR(150) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rotation_version (version_id),
  UNIQUE KEY uq_rotation_version_no (rotation_id, version_no),
  KEY idx_rotation_version_eff (rotation_id, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sequences now belong to a version. unit_span is the raw entered span in the
-- cycle unit (days/weeks/months); duration_days is retained for back-compat.
ALTER TABLE hr_shift_rotation_sequences ADD COLUMN version_id BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE hr_shift_rotation_sequences ADD COLUMN unit_span INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE hr_shift_rotation_sequences ADD COLUMN is_weekly_off TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE hr_shift_rotation_sequences ADD COLUMN label VARCHAR(120) DEFAULT NULL;
CREATE INDEX idx_rotation_seq_version ON hr_shift_rotation_sequences (version_id, sequence_no);

-- Membership gets an end_date (rotations stop naturally / offboarded employees
-- drop off) plus ownership + audit stamps.
ALTER TABLE hr_shift_rotation_employees ADD COLUMN end_date DATE DEFAULT NULL;
ALTER TABLE hr_shift_rotation_employees ADD COLUMN added_by BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE hr_shift_rotation_employees ADD COLUMN added_by_name VARCHAR(150) DEFAULT NULL;
ALTER TABLE hr_shift_rotation_employees ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE hr_shift_rotation_employees ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL;
CREATE INDEX idx_rotation_emp_window ON hr_shift_rotation_employees (employee_id, start_date, end_date);

-- Per-rotation audit trail (mirrors hr_shift_assignment_events).
CREATE TABLE IF NOT EXISTS hr_shift_rotation_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rotation_id VARCHAR(50) NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  summary VARCHAR(255) NOT NULL,
  changes JSON DEFAULT NULL,
  reason VARCHAR(500) DEFAULT NULL,
  actor_id BIGINT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(150) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rotation_event_ref (rotation_id, created_at),
  KEY idx_rotation_event_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- RBAC features.
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Manage Shift Rotations','hr.manage_shift_rotations','Create, edit, version and end shift rotations',19 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Override Shift Rotation Conflicts','hr.override_shift_rotations','Override overlapping rotation membership conflicts',20 FROM modules WHERE slug='hr';
