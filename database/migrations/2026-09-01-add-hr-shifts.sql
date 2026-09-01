CREATE TABLE IF NOT EXISTS hr_shifts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shift_id VARCHAR(50) NOT NULL,
  shift_name VARCHAR(120) NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  break_minutes INT UNSIGNED NOT NULL DEFAULT 0,
  working_hours DECIMAL(5,2) NOT NULL DEFAULT 0,
  overtime_enabled TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  description VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY uq_hr_shifts_shift_id (shift_id), KEY idx_hr_shifts_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Shifts', 'hr.view_shifts', 'View and manage HR shifts', 12 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Manage Shifts', 'hr.manage_shifts', 'Create and edit HR shifts', 13 FROM modules WHERE slug='hr';
