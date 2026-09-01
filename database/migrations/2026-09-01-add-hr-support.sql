CREATE TABLE IF NOT EXISTS hr_support_tickets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(40) NOT NULL UNIQUE,
  employee_id BIGINT UNSIGNED NULL,
  employee_name VARCHAR(150) NULL,
  support_category VARCHAR(80) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  priority ENUM('Low','Medium','High','Urgent') NOT NULL DEFAULT 'Medium',
  attachment_path VARCHAR(500) NULL,
  status ENUM('Open','In Progress','Waiting','Resolved','Closed') NOT NULL DEFAULT 'Open',
  assigned_to BIGINT UNSIGNED NULL,
  assigned_to_name VARCHAR(150) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_response_at DATETIME NULL,
  resolved_at DATETIME NULL,
  resolution TEXT NULL,
  employee_remarks TEXT NULL,
  hr_remarks TEXT NULL,
  sla_due_date DATETIME NULL,
  closed_by VARCHAR(150) NULL,
  closed_at DATETIME NULL,
  INDEX idx_hr_support_status (status),
  INDEX idx_hr_support_employee (employee_id),
  INDEX idx_hr_support_priority (priority),
  INDEX idx_hr_support_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'HR Support', 'hr.view_support', 'View and manage HR support tickets', 5
FROM modules WHERE slug = 'hr';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Manage HR Support', 'hr.manage_support', 'Assign, resolve, and close HR support tickets', 6
FROM modules WHERE slug = 'hr';
