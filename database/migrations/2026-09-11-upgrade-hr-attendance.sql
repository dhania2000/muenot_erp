-- HR Attendance upgrade — additive columns for shift rules, status flags,
-- calendar linkage and admin override auditing. All columns are nullable or
-- defaulted so existing rows and the current clock-in/out flow keep working.
-- The application also creates these lazily (lib/hr-attendance.ts) so applying
-- this migration is recommended but not strictly required.
--
-- MySQL 8 has no ADD COLUMN IF NOT EXISTS; a "Duplicate column" error on a
-- column that already exists is safe to ignore. (MariaDB supports IF NOT EXISTS.)

-- Shift rule configuration used by the attendance calculation engine.
ALTER TABLE `hr_shifts` ADD COLUMN `grace_minutes` INT UNSIGNED NOT NULL DEFAULT 10;
ALTER TABLE `hr_shifts` ADD COLUMN `overtime_threshold_minutes` INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE `hr_shifts` ADD COLUMN `is_overnight` TINYINT(1) NOT NULL DEFAULT 0;
-- Comma-separated weekday numbers (0=Sun .. 6=Sat) that are weekly offs.
ALTER TABLE `hr_shifts` ADD COLUMN `weekly_offs` VARCHAR(30) DEFAULT NULL;

-- Attendance enrichment: exception flags, day type, calendar linkage, override audit.
ALTER TABLE `hr_attendance` ADD COLUMN `flags` VARCHAR(255) DEFAULT NULL;
ALTER TABLE `hr_attendance` ADD COLUMN `day_type` VARCHAR(30) DEFAULT NULL;
ALTER TABLE `hr_attendance` ADD COLUMN `leave_request_id` VARCHAR(50) DEFAULT NULL;
ALTER TABLE `hr_attendance` ADD COLUMN `is_manual_override` TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE `hr_attendance` ADD COLUMN `override_reason` VARCHAR(500) DEFAULT NULL;
ALTER TABLE `hr_attendance` ADD COLUMN `created_by` INT UNSIGNED DEFAULT NULL;
ALTER TABLE `hr_attendance` ADD COLUMN `updated_by` INT UNSIGNED DEFAULT NULL;

-- Speeds up employee + date-range queries (monthly view, employee 360, reports).
ALTER TABLE `hr_attendance` ADD INDEX `idx_hr_attendance_emp_date` (`employee_id`, `work_date`);
