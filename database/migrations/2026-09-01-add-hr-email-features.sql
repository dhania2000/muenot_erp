CREATE TABLE IF NOT EXISTS hr_email_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body LONGTEXT NOT NULL,
  status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_hr_template_name (name)
);

CREATE TABLE IF NOT EXISTS hr_emails (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NULL,
  to_email VARCHAR(190) NOT NULL,
  to_name VARCHAR(150) NULL,
  template_id BIGINT UNSIGNED NULL,
  subject VARCHAR(255) NOT NULL,
  body LONGTEXT NOT NULL,
  status ENUM('Sent','Failed','Draft') NOT NULL DEFAULT 'Sent',
  message_id VARCHAR(255) NULL,
  thread_id VARCHAR(255) NULL,
  opened_at DATETIME NULL,
  open_count INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by BIGINT UNSIGNED NULL,
  INDEX idx_hr_emails_employee (employee_id),
  INDEX idx_hr_emails_opened (opened_at)
);

INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'HR Email Templates','hr.view_email_templates','Manage HR email templates',30 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'HR Emails','hr.view_emails','Send and track HR emails',31 FROM modules WHERE slug='hr';
