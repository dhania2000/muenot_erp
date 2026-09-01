CREATE TABLE IF NOT EXISTS `hr_attendance_regularisation` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id` VARCHAR(40) NOT NULL,
  `attendance_id` BIGINT UNSIGNED DEFAULT NULL,
  `employee_id` BIGINT UNSIGNED NOT NULL,
  `employee_name` VARCHAR(180) NOT NULL,
  `work_date` DATE NOT NULL,
  `requested_clock_in` DATETIME DEFAULT NULL,
  `requested_clock_out` DATETIME DEFAULT NULL,
  `reason` TEXT NOT NULL,
  `attachment_path` VARCHAR(500) DEFAULT NULL,
  `status` ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
  `requested_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reviewed_by` VARCHAR(180) DEFAULT NULL,
  `reviewed_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_hr_regularisation_request` (`request_id`),
  KEY `idx_hr_regularisation_status` (`status`), KEY `idx_hr_regularisation_employee` (`employee_id`),
  CONSTRAINT `fk_hr_regularisation_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hr_regularisation_attendance` FOREIGN KEY (`attendance_id`) REFERENCES `hr_attendance` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Attendance Regularisation','hr.view_regularisation','View attendance regularisation requests',5 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Manage Regularisation','hr.manage_regularisation','Review attendance regularisation requests',6 FROM modules WHERE slug='hr';
