CREATE TABLE IF NOT EXISTS hr_offboarding (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offboarding_id VARCHAR(40) NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  notice_date DATE DEFAULT NULL,
  last_working_date DATE DEFAULT NULL,
  exit_type VARCHAR(80) DEFAULT NULL,
  exit_reason TEXT,
  manager_clearance ENUM('Pending','Cleared','Not Applicable') NOT NULL DEFAULT 'Pending',
  hr_clearance ENUM('Pending','Cleared','Not Applicable') NOT NULL DEFAULT 'Pending',
  it_clearance ENUM('Pending','Cleared','Not Applicable') NOT NULL DEFAULT 'Pending',
  finance_clearance ENUM('Pending','Cleared','Not Applicable') NOT NULL DEFAULT 'Pending',
  asset_return ENUM('Pending','Returned','Not Applicable') NOT NULL DEFAULT 'Pending',
  document_return ENUM('Pending','Returned','Not Applicable') NOT NULL DEFAULT 'Pending',
  exit_interview ENUM('Pending','Completed','Not Applicable') NOT NULL DEFAULT 'Pending',
  final_settlement ENUM('Pending','In Progress','Completed','Not Applicable') NOT NULL DEFAULT 'Pending',
  status ENUM('Initiated','In Progress','Completed','Cancelled') NOT NULL DEFAULT 'Initiated',
  remarks TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY uq_hr_offboarding_id (offboarding_id),
  KEY idx_hr_offboarding_employee (employee_id), KEY idx_hr_offboarding_status (status),
  CONSTRAINT fk_hr_offboarding_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Offboarding', 'hr.view_offboarding', 'Manage employee exits and clearances', 7 FROM modules WHERE slug = 'hr';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Manage Offboarding', 'hr.manage_offboarding', 'Update exit clearances and settlement', 8 FROM modules WHERE slug = 'hr';
