-- =====================================================================
-- hr_attendance
-- Run this once on the live database to create the attendance table used
-- by the Clock In / Clock Out button and the HR > Attendance sub-module.
--
-- One row per employee per day (uq_hr_attendance_employee_date).
--   clock_in       first punch of the day
--   clock_out      last punch of the day
--   active_since   set while a session is open (NULL when clocked out) so an
--                  employee can clock in/out multiple times in the same day
--   break_minutes  gaps between clock-out and the next clock-in (excluded
--                  from working_hours)
--   working_hours  accumulated worked time in hours, breaks excluded
-- =====================================================================

-- Drop any partially-created table from a previous failed import so this is clean to re-run.
DROP TABLE IF EXISTS `hr_attendance`;

CREATE TABLE IF NOT EXISTS `hr_attendance` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `attendance_id` VARCHAR(40) NOT NULL,
  `employee_id` BIGINT UNSIGNED NOT NULL,
  `employee_name` VARCHAR(180) NOT NULL,
  `work_date` DATE NOT NULL,
  `clock_in` DATETIME DEFAULT NULL,
  `clock_out` DATETIME DEFAULT NULL,
  `active_since` DATETIME DEFAULT NULL,
  `break_minutes` INT UNSIGNED NOT NULL DEFAULT 0,
  `working_hours` DECIMAL(6,2) NOT NULL DEFAULT 0,
  `status` VARCHAR(40) NOT NULL DEFAULT 'Present',
  `late_minutes` INT UNSIGNED NOT NULL DEFAULT 0,
  `early_leaving_minutes` INT UNSIGNED NOT NULL DEFAULT 0,
  `overtime_hours` DECIMAL(6,2) NOT NULL DEFAULT 0,
  `location` VARCHAR(180) DEFAULT NULL,
  `latitude` DECIMAL(10,7) DEFAULT NULL,
  `longitude` DECIMAL(10,7) DEFAULT NULL,
  `source` VARCHAR(40) NOT NULL DEFAULT 'Manual',
  `regularisation_required` TINYINT(1) NOT NULL DEFAULT 0,
  `remarks` TEXT,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hr_attendance_employee_date` (`employee_id`, `work_date`),
  KEY `idx_hr_attendance_date` (`work_date`),
  KEY `idx_hr_attendance_employee` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Note: no foreign key to hr_employees — attendance is scoped by employee_id in
-- application code. A DB-level FK fails (errno 150) when hr_employees.id has a
-- different type/charset, and provides no benefit here.

-- If the table already exists without active_since, add it:
-- ALTER TABLE `hr_attendance` ADD COLUMN `active_since` DATETIME DEFAULT NULL AFTER `clock_out`;

-- Register the HR attendance features (safe to re-run).
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Attendance', 'hr.view_attendance', 'View and manage employee attendance', 3 FROM modules WHERE slug = 'hr';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Manage Attendance', 'hr.manage_attendance', 'Create and edit attendance records', 4 FROM modules WHERE slug = 'hr';
