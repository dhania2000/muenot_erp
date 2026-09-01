CREATE TABLE IF NOT EXISTS `hr_employees` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` VARCHAR(50) NOT NULL,
  `employee_name` VARCHAR(150) NOT NULL,
  `gender` VARCHAR(30) DEFAULT NULL, `dob` DATE DEFAULT NULL,
  `personal_email` VARCHAR(190) DEFAULT NULL, `official_email` VARCHAR(190) DEFAULT NULL,
  `mobile` VARCHAR(40) DEFAULT NULL, `alternate_mobile` VARCHAR(40) DEFAULT NULL,
  `address` VARCHAR(255) DEFAULT NULL, `city` VARCHAR(100) DEFAULT NULL, `state` VARCHAR(100) DEFAULT NULL, `country` VARCHAR(100) DEFAULT NULL, `postal_code` VARCHAR(30) DEFAULT NULL,
  `emergency_contact_name` VARCHAR(150) DEFAULT NULL, `emergency_contact_phone` VARCHAR(40) DEFAULT NULL, `emergency_contact_relation` VARCHAR(80) DEFAULT NULL,
  `relative_name` VARCHAR(150) DEFAULT NULL, `relative_relationship` VARCHAR(80) DEFAULT NULL, `relative_primary_phone` VARCHAR(40) DEFAULT NULL, `relative_alternate_phone` VARCHAR(40) DEFAULT NULL, `relative_email` VARCHAR(190) DEFAULT NULL, `relative_address` VARCHAR(255) DEFAULT NULL,
  `department` VARCHAR(120) DEFAULT NULL, `designation` VARCHAR(150) DEFAULT NULL, `reporting_manager` VARCHAR(150) DEFAULT NULL, `employment_type` VARCHAR(80) DEFAULT NULL,
  `joining_date` DATE DEFAULT NULL, `probation_end_date` DATE DEFAULT NULL, `confirmation_date` DATE DEFAULT NULL,
  `employment_status` VARCHAR(80) DEFAULT 'Active', `onboarding_status` VARCHAR(80) DEFAULT NULL, `work_location` VARCHAR(120) DEFAULT NULL, `work_mode` VARCHAR(80) DEFAULT NULL, `shift` VARCHAR(80) DEFAULT NULL, `employee_grade` VARCHAR(50) DEFAULT NULL,
  `document_status` VARCHAR(80) DEFAULT NULL, `agreement_status` VARCHAR(80) DEFAULT NULL, `consent_status` VARCHAR(80) DEFAULT NULL, `compliance_status` VARCHAR(80) DEFAULT NULL, `it_access_status` VARCHAR(80) DEFAULT NULL, `asset_status` VARCHAR(80) DEFAULT NULL, `training_status` VARCHAR(80) DEFAULT NULL, `performance_status` VARCHAR(80) DEFAULT NULL,
  `notice_period` VARCHAR(50) DEFAULT NULL, `notice_period_status` VARCHAR(80) DEFAULT NULL, `exit_status` VARCHAR(80) DEFAULT NULL, `exit_date` DATE DEFAULT NULL, `exit_reason` VARCHAR(255) DEFAULT NULL, `skills` TEXT DEFAULT NULL, `notes` TEXT DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL, `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), UNIQUE KEY `uniq_hr_employee_id` (`employee_id`), KEY `idx_hr_department` (`department`), KEY `idx_hr_status` (`employment_status`), CONSTRAINT `fk_hr_employee_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO modules (name, slug, description, icon, sort_order) SELECT 'HR', 'hr', 'People, employee records, and workforce operations.', 'users', 1 FROM dual WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'hr');
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Employees', 'hr.view_employees', 'View employee master records', 1 FROM modules WHERE slug = 'hr';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Manage Employees', 'hr.manage_employees', 'Create and edit employee records', 2 FROM modules WHERE slug = 'hr';
