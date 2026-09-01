CREATE TABLE IF NOT EXISTS `hr_employee_documents` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` INT UNSIGNED NOT NULL,
  `document_type` VARCHAR(100) NOT NULL,
  `file_name` VARCHAR(255) DEFAULT NULL,
  `file_path` VARCHAR(500) DEFAULT NULL,
  `verified` TINYINT(1) NOT NULL DEFAULT 0,
  `verified_by` INT UNSIGNED DEFAULT NULL,
  `verified_at` DATETIME DEFAULT NULL,
  `status` VARCHAR(50) DEFAULT 'Pending',
  `remarks` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), KEY `idx_hr_doc_employee` (`employee_id`),
  CONSTRAINT `fk_hr_doc_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hr_doc_verified_by` FOREIGN KEY (`verified_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
