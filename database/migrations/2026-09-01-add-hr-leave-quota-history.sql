CREATE TABLE IF NOT EXISTS hr_leave_quota_history (
  event_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  leave_type_id BIGINT UNSIGNED NOT NULL,
  year SMALLINT UNSIGNED NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  days DECIMAL(8,2) NOT NULL,
  reference VARCHAR(190) DEFAULT NULL,
  reason TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_hr_quota_employee_year (employee_id, year),
  INDEX idx_hr_quota_type_year (leave_type_id, year),
  CONSTRAINT fk_hr_quota_employee FOREIGN KEY (employee_id) REFERENCES hr_employees(employee_id) ON DELETE RESTRICT
);

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Leave Quota History', 'hr.view_leave_quota_history', 'View leave balance ledger events', 8
FROM modules WHERE slug = 'hr';
