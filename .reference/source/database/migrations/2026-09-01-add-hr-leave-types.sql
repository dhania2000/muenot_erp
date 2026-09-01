CREATE TABLE IF NOT EXISTS hr_leave_types (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  leave_type_id VARCHAR(40) NOT NULL,
  leave_type VARCHAR(100) NOT NULL,
  annual_quota DECIMAL(8,2) NOT NULL DEFAULT 0,
  carry_forward DECIMAL(8,2) NOT NULL DEFAULT 0,
  max_consecutive_days INT NOT NULL DEFAULT 0,
  requires_document TINYINT(1) NOT NULL DEFAULT 0,
  paid TINYINT(1) NOT NULL DEFAULT 1,
  status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  description TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY uq_hr_leave_type_id (leave_type_id), UNIQUE KEY uq_hr_leave_type_name (leave_type),
  KEY idx_hr_leave_types_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO modules (name, slug, description, icon, sort_order) SELECT 'HR', 'hr', 'People, employee records, and workforce operations.', 'users', 1 FROM dual WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'hr');
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Leave Types', 'hr.view_leave_types', 'Manage leave type policies', 8 FROM modules WHERE slug = 'hr';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Manage Leave Types', 'hr.manage_leave_types', 'Create and edit leave type policies', 9 FROM modules WHERE slug = 'hr';
