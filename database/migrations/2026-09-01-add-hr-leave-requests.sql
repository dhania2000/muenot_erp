CREATE TABLE IF NOT EXISTS hr_leave_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(40) NOT NULL UNIQUE,
  employee_id BIGINT NOT NULL,
  employee_name VARCHAR(150) NOT NULL,
  leave_type_id VARCHAR(80) NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  days DECIMAL(6,2) NOT NULL,
  reason TEXT NOT NULL,
  attachment_url VARCHAR(500) DEFAULT NULL,
  status ENUM('Pending','Manager Approved','Manager Rejected','HR Approved','HR Rejected','Cancelled') NOT NULL DEFAULT 'Pending',
  manager_id BIGINT DEFAULT NULL,
  hr_reviewer_id BIGINT DEFAULT NULL,
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  manager_action_at DATETIME DEFAULT NULL,
  hr_action_at DATETIME DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  INDEX idx_hr_leave_employee (employee_id),
  INDEX idx_hr_leave_status (status),
  INDEX idx_hr_leave_dates (from_date, to_date),
  CONSTRAINT fk_hr_leave_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT
);
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order) SELECT id,'Leave Requests','hr.view_leave_requests','View and manage employee leave requests',7 FROM modules WHERE slug='hr';
