CREATE TABLE IF NOT EXISTS hr_leave_balances (
  balance_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  leave_type_id BIGINT UNSIGNED NOT NULL,
  `year` YEAR NOT NULL,
  opening DECIMAL(8,2) NOT NULL DEFAULT 0,
  accrued DECIMAL(8,2) NOT NULL DEFAULT 0,
  used DECIMAL(8,2) NOT NULL DEFAULT 0,
  pending DECIMAL(8,2) NOT NULL DEFAULT 0,
  available DECIMAL(8,2) AS (opening + accrued + adjusted - used - pending) STORED,
  adjusted DECIMAL(8,2) NOT NULL DEFAULT 0,
  last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_hr_leave_balance (employee_id, leave_type_id, `year`),
  INDEX idx_hr_leave_balance_employee (employee_id),
  CONSTRAINT fk_hr_leave_balance_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Leave Balances', 'hr.view_leave_balances', 'View and manage employee leave balances', 8
FROM modules WHERE slug = 'hr';
