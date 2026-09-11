-- Upgrade Attendance Regularisation into a proper correction + approval workflow
-- that is tightly linked to the central hr_attendance record.
--
-- Additive and idempotent: every column is nullable and guarded with
-- IF NOT EXISTS so re-running (or the app's lazy ensureRegularisationSchema)
-- is safe even after the runtime already added these objects. Mirrors the
-- columns created lazily in lib/hr-regularisation.ts.

-- Widen the lifecycle status to include Cancelled (base table used an ENUM).
ALTER TABLE `hr_attendance_regularisation`
  MODIFY COLUMN `status` VARCHAR(20) NOT NULL DEFAULT 'Pending';

-- Workflow + snapshot columns (added individually and idempotently).
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `correction_type` VARCHAR(50) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `current_clock_in` DATETIME DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `current_clock_out` DATETIME DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `current_status` VARCHAR(50) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `requested_status` VARCHAR(50) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `department` VARCHAR(180) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `designation` VARCHAR(180) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `reporting_manager` VARCHAR(180) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `requested_by` INT UNSIGNED DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `requested_by_name` VARCHAR(180) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `rejection_reason` TEXT DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `applied_at` DATETIME DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `attachment_name` VARCHAR(255) DEFAULT NULL;

ALTER TABLE `hr_attendance_regularisation` ADD INDEX IF NOT EXISTS `idx_reg_emp_date` (`employee_id`, `work_date`);

-- Feature slugs already registered by 2026-09-01-add-hr-attendance-regularisation.sql:
--   hr.view_regularisation   — view / create own requests
--   hr.manage_regularisation — approve / reject / view all requests
