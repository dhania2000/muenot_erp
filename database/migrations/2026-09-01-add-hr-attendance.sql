CREATE TABLE IF NOT EXISTS `hr_attendance` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `attendance_id` VARCHAR(40) NOT NULL,
  `employee_id` BIGINT UNSIGNED NOT NULL,
  `employee_name` VARCHAR(180) NOT NULL,
  `work_date` DATE NOT NULL,
  `clock_in` DATETIME DEFAULT NULL,
  `clock_out` DATETIME DEFAULT NULL,
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
  CONSTRAINT `fk_hr_attendance_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Attendance', 'hr.view_attendance', 'View and manage employee attendance', 3 FROM modules WHERE slug = 'hr';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Manage Attendance', 'hr.manage_attendance', 'Create and edit attendance records', 4 FROM modules WHERE slug = 'hr';
