-- FILE: 2026-08-30-add-email-features.sql
-- =============================================================
-- Migration: Sales Email Templates + Email Sending + Open Tracking
-- Run this in phpMyAdmin (Hostinger) after the base schema.
-- Safe to run once. Uses IF NOT EXISTS where possible.
-- =============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -------------------------------------------------------------
-- Table: sales_email_templates
-- Reusable email templates that can be selected when emailing a lead.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_email_templates` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(150) NOT NULL,
  `subject` VARCHAR(255) NOT NULL,
  `body` MEDIUMTEXT NOT NULL,
  `category` VARCHAR(80) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_email_templates_created_by` (`created_by`),
  CONSTRAINT `fk_email_templates_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: sales_emails
-- One row per email sent to a lead. `tracking_token` is embedded in an
-- invisible tracking pixel so we can detect opens without the recipient
-- knowing. `open_count` / `first_opened_at` / `last_opened_at` are updated
-- when the pixel is loaded.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_emails` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lead_id` INT UNSIGNED DEFAULT NULL,
  `template_id` INT UNSIGNED DEFAULT NULL,
  `to_email` VARCHAR(190) NOT NULL,
  `to_name` VARCHAR(190) DEFAULT NULL,
  `subject` VARCHAR(255) NOT NULL,
  `body` MEDIUMTEXT NOT NULL,
  `tracking_token` VARCHAR(64) NOT NULL,
  `status` ENUM('Sent','Failed','Opened') NOT NULL DEFAULT 'Sent',
  `error_message` VARCHAR(500) DEFAULT NULL,
  `open_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `first_opened_at` DATETIME DEFAULT NULL,
  `last_opened_at` DATETIME DEFAULT NULL,
  `sent_by` INT UNSIGNED DEFAULT NULL,
  `sent_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_email_token` (`tracking_token`),
  KEY `idx_emails_lead` (`lead_id`),
  KEY `idx_emails_status` (`status`),
  CONSTRAINT `fk_emails_lead` FOREIGN KEY (`lead_id`) REFERENCES `sales_leads` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_emails_template` FOREIGN KEY (`template_id`) REFERENCES `sales_email_templates` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_emails_sent_by` FOREIGN KEY (`sent_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: sales_email_events
-- Detailed log of every open event (each pixel hit) for auditing.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_email_events` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email_id` INT UNSIGNED NOT NULL,
  `event_type` VARCHAR(30) NOT NULL DEFAULT 'open',
  `user_agent` VARCHAR(400) DEFAULT NULL,
  `ip_address` VARCHAR(60) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_events_email` (`email_id`),
  CONSTRAINT `fk_events_email` FOREIGN KEY (`email_id`) REFERENCES `sales_emails` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- -------------------------------------------------------------
-- New Sales features (permissions). module_id = 2 is Sales.
-- -------------------------------------------------------------
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT 2, 'View Email Templates', 'sales.view_email_templates', 'View sales email templates', 13
WHERE NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'sales.view_email_templates');

INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT 2, 'Manage Email Templates', 'sales.manage_email_templates', 'Create, edit, and delete email templates', 14
WHERE NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'sales.manage_email_templates');

INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT 2, 'Send Emails', 'sales.send_emails', 'Send tracked emails to leads', 15
WHERE NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'sales.send_emails');

-- Seed a few starter templates (optional).
INSERT INTO `sales_email_templates` (`name`, `subject`, `body`, `category`)
SELECT * FROM (
  SELECT
    'Introduction' AS name,
    'Great to connect, {{contact_person}}' AS subject,
    '<p>Hi {{contact_person}},</p><p>Thanks for your interest in {{company_name}} working with Muenot. I''d love to show you how we can help.</p><p>Are you free for a quick call this week?</p><p>Best regards,<br/>The Muenot Team</p>' AS body,
    'Outreach' AS category
) AS t
WHERE NOT EXISTS (SELECT 1 FROM `sales_email_templates` WHERE `name` = 'Introduction');

INSERT INTO `sales_email_templates` (`name`, `subject`, `body`, `category`)
SELECT * FROM (
  SELECT
    'Follow-up' AS name,
    'Following up, {{contact_person}}' AS subject,
    '<p>Hi {{contact_person}},</p><p>Just circling back on my previous note. Do you have any questions I can help with?</p><p>Best regards,<br/>The Muenot Team</p>' AS body,
    'Follow-up' AS category
) AS t
WHERE NOT EXISTS (SELECT 1 FROM `sales_email_templates` WHERE `name` = 'Follow-up');



-- FILE: 2026-08-30-add-lead-status.sql
-- =============================================================
-- Migration: Add `lead_status` column to sales_leads
-- Run this ONCE on your existing live database (phpMyAdmin -> SQL tab).
-- Safe to run even if some leads already exist â€” it backfills sensible
-- defaults based on the existing `status` column.
-- =============================================================

ALTER TABLE `sales_leads`
  ADD COLUMN `lead_status` ENUM('Open','Won','Lost','Follow Up') NOT NULL DEFAULT 'Open' AFTER `status`,
  ADD KEY `idx_leads_lead_status` (`lead_status`);

-- Backfill existing rows so leads already marked Won / Lost / Follow Up
-- immediately show up in the correct tab instead of staying in "Lead".
UPDATE `sales_leads` SET `lead_status` = 'Won' WHERE `status` = 'Won';
UPDATE `sales_leads` SET `lead_status` = 'Lost' WHERE `status` = 'Lost';
UPDATE `sales_leads` SET `lead_status` = 'Follow Up' WHERE `status` IN ('Follow Up 1', 'Follow Up 2');



-- FILE: 2026-08-31-add-environment-variables.sql
CREATE TABLE IF NOT EXISTS `environment_variables` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `category` VARCHAR(80) NOT NULL DEFAULT 'General',
  `value_encrypted` BLOB NOT NULL,
  `is_secret` TINYINT(1) NOT NULL DEFAULT 1,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_environment_variable_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-08-31-add-lead-source-url.sql
ALTER TABLE `sales_leads`
  ADD COLUMN `source_url` VARCHAR(500) DEFAULT NULL AFTER `designation`;



-- FILE: 2026-09-01-add-admin-settings.sql
CREATE TABLE IF NOT EXISTS admin_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(120) NOT NULL UNIQUE,
  category VARCHAR(80) NOT NULL,
  label VARCHAR(160) NOT NULL,
  description VARCHAR(500) DEFAULT NULL,
  value TEXT DEFAULT NULL,
  value_type ENUM('text','number','boolean','select','url') NOT NULL DEFAULT 'text',
  is_secret BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_admin_settings_category (category)
);



-- FILE: 2026-09-01-add-automatic-record-ids.sql
CREATE TABLE IF NOT EXISTS record_id_sequences (
  prefix VARCHAR(20) NOT NULL PRIMARY KEY,
  next_number INT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO record_id_sequences (prefix, next_number) VALUES
('EMP', 0), ('INV', 0), ('FIN', 0), ('GST', 0), ('TDS', 0), ('JE', 0), ('GL', 0), ('RPT', 0), ('PROJ', 0), ('TKT', 0), ('CLI', 0), ('PROD', 0),
('LEAD', 0), ('COMP', 0), ('MEET', 0), ('QUOTE', 0), ('CONT', 0), ('ONB', 0), ('FORE', 0), ('REG', 0), ('LR', 0), ('DOC', 0), ('SHIFT', 0)
ON DUPLICATE KEY UPDATE prefix = VALUES(prefix);

-- Backfill legacy employee IDs while preserving the internal numeric primary key.
SET @employee_counter := 0;
UPDATE hr_employees
SET employee_id = CONCAT('EMP-', LPAD((@employee_counter := @employee_counter + 1), 4, '0'))
WHERE employee_id IS NULL OR employee_id = '' OR employee_id NOT LIKE 'EMP-%'
ORDER BY id;

UPDATE record_id_sequences
SET next_number = GREATEST(next_number, (SELECT COUNT(*) FROM hr_employees WHERE employee_id LIKE 'EMP-%'))
WHERE prefix = 'EMP';



-- FILE: 2026-09-01-add-clients-tickets-products.sql
INSERT INTO modules (slug, name, description, sort_order)
VALUES
 ('clients','Clients','Client profiles and account relationships',30),
 ('tickets','Tickets','Support requests and service work',31),
 ('products','Products','Product catalog, pricing, and inventory',32)
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description), sort_order=VALUES(sort_order);

INSERT INTO features (module_id, slug, name, description)
SELECT m.id, CONCAT(m.slug,'.view_dashboard'), 'View Dashboard', CONCAT('Access ', m.name, ' dashboard')
FROM modules m WHERE m.slug IN ('clients','tickets','products')
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);

INSERT INTO features (module_id, slug, name, description)
SELECT m.id, CONCAT(m.slug,'.view_', CASE m.slug WHEN 'clients' THEN 'clients' WHEN 'tickets' THEN 'tickets' ELSE 'products' END), CONCAT('View ', m.name), CONCAT('View ', m.name, ' records')
FROM modules m WHERE m.slug IN ('clients','tickets','products')
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);



-- FILE: 2026-09-01-add-email-template-attachments.sql
ALTER TABLE sales_email_templates ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(500) NULL, ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL, ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL, ADD COLUMN IF NOT EXISTS attachment_size INT NULL;
ALTER TABLE hr_email_templates ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(500) NULL, ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL, ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL, ADD COLUMN IF NOT EXISTS attachment_size INT NULL;
ALTER TABLE finance_email_templates ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(500) NULL, ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL, ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL, ADD COLUMN IF NOT EXISTS attachment_size INT NULL;
ALTER TABLE operations_email_templates ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(500) NULL, ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL, ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL, ADD COLUMN IF NOT EXISTS attachment_size INT NULL;



-- FILE: 2026-09-01-add-employee-documents.sql
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



-- FILE: 2026-09-01-add-finance-filing-features.sql
-- Add Finance filing and reporting features for the Finance dropdown.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'GST Filing', 'finance.gst_filing', 'Manage GST returns and liabilities', 20 FROM modules WHERE slug = 'finance';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'TDS Filing', 'finance.tds_filing', 'Manage TDS returns and payments', 21 FROM modules WHERE slug = 'finance';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Journal Entries', 'finance.journal_entries', 'Create and review journal entries', 22 FROM modules WHERE slug = 'finance';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'General Ledger', 'finance.general_ledger', 'View general ledger transactions', 23 FROM modules WHERE slug = 'finance';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Financial Reports', 'finance.financial_reports', 'Generate financial reports', 24 FROM modules WHERE slug = 'finance';



-- FILE: 2026-09-01-add-finance-module.sql
CREATE TABLE IF NOT EXISTS finance_records (
  record_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  module_key VARCHAR(40) NOT NULL,
  reference_no VARCHAR(80) DEFAULT NULL,
  record_date DATE DEFAULT NULL,
  party_name VARCHAR(190) DEFAULT NULL,
  account_name VARCHAR(190) DEFAULT NULL,
  record_type VARCHAR(80) DEFAULT NULL,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  debit DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit DECIMAL(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(40) NOT NULL DEFAULT 'Draft',
  description TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (record_id), KEY idx_finance_module (module_key), KEY idx_finance_date (record_date), KEY idx_finance_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO modules (name, slug, description, icon, sort_order) SELECT 'Finance', 'finance', 'Billing, expenses, banking, and finance masters.', 'wallet', 2 FROM dual WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'finance');
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Finance', 'finance.view_dashboard', 'View finance module', 1 FROM modules WHERE slug = 'finance';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Manage Finance', 'finance.manage_records', 'Create and edit finance records', 2 FROM modules WHERE slug = 'finance';



-- FILE: 2026-09-01-add-finance-operations-dashboard.sql
-- Adds bank-reconciliation tracking to finance_records so the Finance Dashboard
-- can show a Reconciled / Unreconciled / Exception breakdown for bank transactions.
ALTER TABLE finance_records
  ADD COLUMN reconciliation_status ENUM('Reconciled','Unreconciled','Exception') DEFAULT NULL AFTER status;

-- Helpful index for the dashboard's "recent bank transactions" + reconciliation queries.
ALTER TABLE finance_records
  ADD INDEX idx_finance_reconciliation (module_key, reconciliation_status);



-- FILE: 2026-09-01-add-finance-operations-emails.sql
CREATE TABLE IF NOT EXISTS finance_email_templates (id BIGINT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(150) NOT NULL, subject VARCHAR(255) NOT NULL, body LONGTEXT NOT NULL, status ENUM('Active','Inactive') DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS operations_email_templates (id BIGINT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(150) NOT NULL, subject VARCHAR(255) NOT NULL, body LONGTEXT NOT NULL, status ENUM('Active','Inactive') DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS finance_emails (id BIGINT PRIMARY KEY AUTO_INCREMENT, to_email VARCHAR(320) NOT NULL, subject VARCHAR(255) NOT NULL, body LONGTEXT NOT NULL, status VARCHAR(30) DEFAULT 'Queued', sent_at DATETIME NULL, opened_at DATETIME NULL, created_by VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS operations_emails (id BIGINT PRIMARY KEY AUTO_INCREMENT, to_email VARCHAR(320) NOT NULL, subject VARCHAR(255) NOT NULL, body LONGTEXT NOT NULL, status VARCHAR(30) DEFAULT 'Queued', sent_at DATETIME NULL, opened_at DATETIME NULL, created_by VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);



-- FILE: 2026-09-01-add-hr-attendance.sql
CREATE TABLE IF NOT EXISTS `hr_attendance` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `attendance_id` VARCHAR(40) NOT NULL,
  `employee_id` BIGINT UNSIGNED NOT NULL,
  `employee_name` VARCHAR(180) NOT NULL,
  `work_date` DATE NOT NULL,
  `clock_in` DATETIME DEFAULT NULL,
  `clock_out` DATETIME DEFAULT NULL,
  `break_minutes` INT UNSIGNED NOT NULL DEFAULT 0,
  `working_hours` DECIMAL(6,2) NOT NULL DEFAULT 0,
  `status` VARCHAR(40) NOT NULL DEFAULT 'Present',
  `late_minutes` INT UNSIGNED NOT NULL DEFAULT 0,
  `early_leaving_minutes` INT UNSIGNED NOT NULL DEFAULT 0,
  `overtime_hours` DECIMAL(6,2) NOT NULL DEFAULT 0,
  `location` VARCHAR(180) DEFAULT NULL,
  `latitude` DECIMAL(10,7) DEFAULT NULL,
  `longitude` DECIMAL(10,7) DEFAULT NULL,
  `source` VARCHAR(40) NOT NULL DEFAULT 'Manual',
  `regularisation_required` TINYINT(1) NOT NULL DEFAULT 0,
  `remarks` TEXT,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hr_attendance_employee_date` (`employee_id`, `work_date`),
  KEY `idx_hr_attendance_date` (`work_date`),
  CONSTRAINT `fk_hr_attendance_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Attendance', 'hr.view_attendance', 'View and manage employee attendance', 3 FROM modules WHERE slug = 'hr';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Manage Attendance', 'hr.manage_attendance', 'Create and edit attendance records', 4 FROM modules WHERE slug = 'hr';



-- FILE: 2026-09-01-add-hr-attendance-regularisation.sql
CREATE TABLE IF NOT EXISTS `hr_attendance_regularisation` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id` VARCHAR(40) NOT NULL,
  `attendance_id` BIGINT UNSIGNED DEFAULT NULL,
  `employee_id` BIGINT UNSIGNED NOT NULL,
  `employee_name` VARCHAR(180) NOT NULL,
  `work_date` DATE NOT NULL,
  `requested_clock_in` DATETIME DEFAULT NULL,
  `requested_clock_out` DATETIME DEFAULT NULL,
  `reason` TEXT NOT NULL,
  `attachment_path` VARCHAR(500) DEFAULT NULL,
  `status` ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
  `requested_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reviewed_by` VARCHAR(180) DEFAULT NULL,
  `reviewed_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_hr_regularisation_request` (`request_id`),
  KEY `idx_hr_regularisation_status` (`status`), KEY `idx_hr_regularisation_employee` (`employee_id`),
  CONSTRAINT `fk_hr_regularisation_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hr_regularisation_attendance` FOREIGN KEY (`attendance_id`) REFERENCES `hr_attendance` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Attendance Regularisation','hr.view_regularisation','View attendance regularisation requests',5 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Manage Regularisation','hr.manage_regularisation','Review attendance regularisation requests',6 FROM modules WHERE slug='hr';



-- FILE: 2026-09-01-add-hr-email-features.sql
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



-- FILE: 2026-09-01-add-hr-employees.sql
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



-- FILE: 2026-09-01-add-hr-leave-balances.sql
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



-- FILE: 2026-09-01-add-hr-leave-quota-history.sql
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



-- FILE: 2026-09-01-add-hr-leave-requests.sql
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



-- FILE: 2026-09-01-add-hr-leave-types.sql
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



-- FILE: 2026-09-01-add-hr-master-features.sql
CREATE TABLE IF NOT EXISTS hr_departments (department_id VARCHAR(40) PRIMARY KEY, department_name VARCHAR(150) NOT NULL, parent_department_id VARCHAR(40), head_employee_id VARCHAR(40), description TEXT, status VARCHAR(30) NOT NULL DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_designations (designation_id VARCHAR(40) PRIMARY KEY, designation_name VARCHAR(150) NOT NULL, parent_designation_id VARCHAR(40), level_name VARCHAR(80), description TEXT, status VARCHAR(30) NOT NULL DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_promotions (promotion_id BIGINT AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT NOT NULL, effective_date DATE NOT NULL, old_designation_id VARCHAR(40), new_designation_id VARCHAR(40), old_department_id VARCHAR(40), new_department_id VARCHAR(40), old_grade VARCHAR(80), new_grade VARCHAR(80), old_salary DECIMAL(14,2), new_salary DECIMAL(14,2), reason TEXT, approved_by BIGINT, approver_name VARCHAR(150), status VARCHAR(30) DEFAULT 'Pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_awards (award_id BIGINT AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT NOT NULL, award_name VARCHAR(180) NOT NULL, award_date DATE NOT NULL, given_by VARCHAR(150), description TEXT, badge_url VARCHAR(500), status VARCHAR(30) DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_appreciations (appreciation_id BIGINT AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT NOT NULL, title VARCHAR(180) NOT NULL, message TEXT NOT NULL, given_by VARCHAR(150), appreciation_date DATE NOT NULL, category VARCHAR(80), status VARCHAR(30) DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_passport_visa (record_id BIGINT AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT NOT NULL, passport_number VARCHAR(80), passport_issue_date DATE, passport_expiry_date DATE, visa_type VARCHAR(80), visa_number VARCHAR(80), visa_issue_date DATE, visa_expiry_date DATE, country VARCHAR(100), status VARCHAR(30) DEFAULT 'Active', passport_path VARCHAR(500), visa_path VARCHAR(500), remarks TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_holidays (holiday_id BIGINT AUTO_INCREMENT PRIMARY KEY, holiday_name VARCHAR(180) NOT NULL, holiday_date DATE NOT NULL, holiday_type VARCHAR(80), applicable_department_id VARCHAR(40), applicable_state_ut VARCHAR(100), optional TINYINT(1) DEFAULT 0, description TEXT, status VARCHAR(30) DEFAULT 'Active', year INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
INSERT IGNORE INTO modules (name, slug, description, icon, sort_order) SELECT 'HR', 'hr', 'People operations', 'users', 1 FROM dual WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug='hr');
INSERT IGNORE INTO features (module_id,name,slug,sort_order) SELECT id,'HR Master Data','hr.view_master_data',30 FROM modules WHERE slug='hr';



-- FILE: 2026-09-01-add-hr-offboarding.sql
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



-- FILE: 2026-09-01-add-hr-shifts.sql
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



-- FILE: 2026-09-01-add-hr-shift-workflows.sql
CREATE TABLE IF NOT EXISTS hr_shift_change_requests (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, request_id VARCHAR(50) NOT NULL, employee_id BIGINT UNSIGNED NOT NULL, current_shift_id BIGINT UNSIGNED NULL, requested_shift_id BIGINT UNSIGNED NULL, from_date DATE NOT NULL, to_date DATE NULL, reason VARCHAR(500), status ENUM('Pending','Approved','Rejected','Cancelled') NOT NULL DEFAULT 'Pending', requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_by BIGINT UNSIGNED NULL, reviewed_at DATETIME NULL, review_remarks VARCHAR(500), PRIMARY KEY(id), UNIQUE KEY uq_shift_change_request(request_id), KEY idx_shift_change_employee(employee_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS hr_shift_assignments (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, assignment_id VARCHAR(50) NOT NULL, employee_id BIGINT UNSIGNED NOT NULL, shift_id BIGINT UNSIGNED NOT NULL, effective_from DATE NOT NULL, effective_to DATE NULL, status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active', assigned_by BIGINT UNSIGNED NULL, notes VARCHAR(500), PRIMARY KEY(id), UNIQUE KEY uq_shift_assignment(assignment_id), KEY idx_shift_assignment_employee(employee_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS hr_shift_rotations (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, rotation_id VARCHAR(50) NOT NULL, rotation_name VARCHAR(120) NOT NULL, description VARCHAR(500), cycle_type ENUM('Days','Weeks','Months') NOT NULL DEFAULT 'Weeks', cycle_length INT UNSIGNED NOT NULL DEFAULT 1, status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active', start_date DATE NOT NULL, created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(id), UNIQUE KEY uq_rotation(rotation_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS hr_shift_rotation_sequences (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, sequence_id VARCHAR(50) NOT NULL, rotation_id BIGINT UNSIGNED NOT NULL, sequence_no INT UNSIGNED NOT NULL, shift_id BIGINT UNSIGNED NOT NULL, duration_days INT UNSIGNED NOT NULL DEFAULT 1, PRIMARY KEY(id), UNIQUE KEY uq_rotation_sequence(sequence_id), UNIQUE KEY uq_rotation_order(rotation_id,sequence_no)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS hr_shift_rotation_employees (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, record_id VARCHAR(50) NOT NULL, rotation_id BIGINT UNSIGNED NOT NULL, employee_id BIGINT UNSIGNED NOT NULL, start_date DATE NOT NULL, current_sequence INT UNSIGNED NOT NULL DEFAULT 1, last_run DATE NULL, next_run DATE NULL, status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active', PRIMARY KEY(id), UNIQUE KEY uq_rotation_employee(record_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order) SELECT id,'Shift Change Requests','hr.view_shift_change_requests','Review shift changes',14 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order) SELECT id,'Shift Assignments','hr.view_shift_assignments','Manage shift assignments',15 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order) SELECT id,'Shift Rotations','hr.view_shift_rotations','Manage shift rotations',16 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order) SELECT id,'Rotation Sequences','hr.view_rotation_sequences','Manage rotation sequences',17 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order) SELECT id,'Rotation Employees','hr.view_rotation_employees','Manage rotation employees',18 FROM modules WHERE slug='hr';



-- FILE: 2026-09-01-add-hr-support.sql
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



-- FILE: 2026-09-01-add-messaging.sql
CREATE TABLE IF NOT EXISTS message_permissions (id INT AUTO_INCREMENT PRIMARY KEY, employee_id INT NOT NULL, can_message_employees BOOLEAN NOT NULL DEFAULT TRUE, can_message_admins BOOLEAN NOT NULL DEFAULT TRUE, can_message_management BOOLEAN NOT NULL DEFAULT TRUE, allowed_department VARCHAR(120) NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uq_message_permission_employee (employee_id));
CREATE TABLE IF NOT EXISTS conversations (id INT AUTO_INCREMENT PRIMARY KEY, subject VARCHAR(200) NULL, created_by INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS conversation_participants (conversation_id INT NOT NULL, user_id INT NOT NULL, last_read_at DATETIME NULL, PRIMARY KEY (conversation_id, user_id));
CREATE TABLE IF NOT EXISTS messages (id INT AUTO_INCREMENT PRIMARY KEY, conversation_id INT NOT NULL, sender_id INT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_messages_conversation (conversation_id, created_at));
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order) SELECT id,'Messages','messages.view','View and use internal messaging',90 FROM modules WHERE slug='messages';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order) SELECT id,'Message permissions','messages.manage_permissions','Manage employee messaging controls',91 FROM modules WHERE slug='messages';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order) SELECT id,'Messaging','messages.send','Send internal messages',92 FROM modules WHERE slug='messages';
ALTER TABLE messages ADD CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE conversation_participants ADD CONSTRAINT fk_cp_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;



-- FILE: 2026-09-01-add-operations-module.sql
CREATE TABLE IF NOT EXISTS operations_resources (resource_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT UNSIGNED NULL, resource_name VARCHAR(160) NOT NULL, resource_type ENUM('FTE','Freelancer','Contractor') NOT NULL DEFAULT 'FTE', skill_set VARCHAR(255), capacity_hours DECIMAL(8,2) NOT NULL DEFAULT 160, status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active', notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, INDEX idx_ops_resource_status(status));
CREATE TABLE IF NOT EXISTS operations_projects (project_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_name VARCHAR(190) NOT NULL, client_name VARCHAR(190), manager_name VARCHAR(160), start_date DATE, end_date DATE, status ENUM('Planned','Active','On Hold','Completed','Cancelled') NOT NULL DEFAULT 'Planned', priority ENUM('Low','Medium','High','Critical') NOT NULL DEFAULT 'Medium', sla_due_date DATE, description TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS operations_allocations (allocation_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL, resource_id BIGINT UNSIGNED NOT NULL, allocation_percent DECIMAL(5,2) NOT NULL DEFAULT 100, from_date DATE NOT NULL, to_date DATE, status ENUM('Planned','Active','Released') NOT NULL DEFAULT 'Planned', assigned_by VARCHAR(160), notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(project_id), INDEX(resource_id));
CREATE TABLE IF NOT EXISTS operations_quality_reviews (review_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NULL, resource_id BIGINT UNSIGNED NULL, review_date DATE NOT NULL, quality_score DECIMAL(5,2), sla_score DECIMAL(5,2), status ENUM('Open','Passed','Needs Improvement') NOT NULL DEFAULT 'Open', reviewer_name VARCHAR(160), remarks TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS operations_issues (issue_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NULL, resource_id BIGINT UNSIGNED NULL, title VARCHAR(190) NOT NULL, description TEXT, priority ENUM('Low','Medium','High','Critical') NOT NULL DEFAULT 'Medium', status ENUM('Open','In Progress','Resolved','Closed') NOT NULL DEFAULT 'Open', assigned_to VARCHAR(160), due_date DATE, resolved_at DATETIME NULL, remarks TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
INSERT IGNORE INTO modules(name,slug,description,icon,sort_order) SELECT 'Operations','operations','Resources, projects, allocations, quality, and delivery operations.','briefcase',2 FROM dual WHERE NOT EXISTS(SELECT 1 FROM modules WHERE slug='operations');
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order) SELECT id,'Operations','operations.view_dashboard','View operations module',1 FROM modules WHERE slug='operations';



-- FILE: 2026-09-01-add-workspace-modules.sql
-- Add the shared workspace modules and their permission-gated features.
INSERT INTO modules (slug, name, description, sort_order)
VALUES
 ('calendar','My Calendar','Personal schedule and shared calendar events',20),
 ('events','Events','Company events and registrations',21),
 ('messages','Messages','Internal team conversations',22),
 ('notice-board','Notice Board','Company announcements and notices',23),
 ('knowledge-base','Knowledge Base','Searchable company knowledge',24),
 ('assets','Assets','Equipment and asset register',25),
 ('biolinks','Biolinks','Shareable profile links',26),
 ('biometric','Biometric','Attendance device and punch records',27),
 ('letter','Letter','Employee letters and documents',28),
 ('monitor-center','Monitor Center','System activity and health monitoring',29)
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);

INSERT INTO features (module_id, slug, name, description)
SELECT m.id, CONCAT(m.slug,'.view'), CONCAT('View ',m.name), CONCAT('Access ',m.name,' workspace')
FROM modules m WHERE m.slug IN ('calendar','events','messages','notice-board','knowledge-base','assets','biolinks','biometric','letter','monitor-center')
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);



-- FILE: 2026-09-06-add-company-settings.sql
-- Key/value store backing the Company Settings screens.
CREATE TABLE IF NOT EXISTS company_settings (
  skey VARCHAR(160) NOT NULL PRIMARY KEY,
  svalue TEXT DEFAULT NULL,
  updated_by BIGINT UNSIGNED DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);



-- FILE: 2026-09-06-add-hr-letters.sql
-- HR Letter feature (modeled on Worksuite's account/letter screen).
-- Letter templates hold reusable content with {{placeholders}}.
-- Issued letters store a rendered snapshot merged with employee + company data.

CREATE TABLE IF NOT EXISTS `hr_letter_templates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(150) NOT NULL,
  `letter_type` VARCHAR(80) NOT NULL DEFAULT 'Offer Letter',
  `subject` VARCHAR(255) NOT NULL,
  `body` LONGTEXT NOT NULL,
  `status` ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_hr_letter_template_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `hr_letters` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `letter_number` VARCHAR(40) NOT NULL,
  `employee_id` INT UNSIGNED NOT NULL,
  `template_id` BIGINT UNSIGNED NULL,
  `letter_type` VARCHAR(80) NOT NULL DEFAULT 'Offer Letter',
  `subject` VARCHAR(255) NOT NULL,
  `body` LONGTEXT NOT NULL,
  `issue_date` DATE NOT NULL,
  `status` ENUM('Draft','Issued') NOT NULL DEFAULT 'Draft',
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_hr_letter_number` (`letter_number`),
  KEY `idx_hr_letters_employee` (`employee_id`),
  KEY `idx_hr_letters_template` (`template_id`),
  CONSTRAINT `fk_hr_letters_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hr_letters_template` FOREIGN KEY (`template_id`) REFERENCES `hr_letter_templates` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sidebar features (gated by permissions, like the rest of the HR module).
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'HR Letter Templates','hr.view_letter_templates','Create and manage letter templates',32 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'HR Letters','hr.view_letters','Issue letters to employees',33 FROM modules WHERE slug='hr';



-- FILE: 2026-09-06-add-sales-invoices.sql
-- Dedicated Sales Invoices table for the Finance module.
-- Sales invoices carry far more structure than the shared finance_records
-- table can hold (GST breakup, TDS, payment tracking, e-invoice / e-way refs),
-- so they get their own table while still using the INV-#### id sequence.

CREATE TABLE IF NOT EXISTS sales_invoices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id VARCHAR(40) NOT NULL,
  invoice_date DATE DEFAULT NULL,
  invoice_type VARCHAR(40) NOT NULL DEFAULT 'Tax Invoice',
  financial_year VARCHAR(12) DEFAULT NULL,
  client_id VARCHAR(40) DEFAULT NULL,
  client_name VARCHAR(190) DEFAULT NULL,
  project_id VARCHAR(40) DEFAULT NULL,
  project_name VARCHAR(190) DEFAULT NULL,
  billing_period_from DATE DEFAULT NULL,
  billing_period_to DATE DEFAULT NULL,
  description TEXT,
  hsn_sac VARCHAR(20) DEFAULT NULL,
  quantity DECIMAL(14,2) NOT NULL DEFAULT 0,
  unit VARCHAR(20) DEFAULT NULL,
  rate DECIMAL(14,2) NOT NULL DEFAULT 0,
  taxable_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
  cgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
  sgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
  igst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  other_tax_cess DECIMAL(14,2) NOT NULL DEFAULT 0,
  invoice_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds_applicable TINYINT(1) NOT NULL DEFAULT 0,
  tds_section VARCHAR(20) DEFAULT NULL,
  tds_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
  tds_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_receivable DECIMAL(14,2) NOT NULL DEFAULT 0,
  due_date DATE DEFAULT NULL,
  amount_received DECIMAL(14,2) NOT NULL DEFAULT 0,
  outstanding_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  payment_status VARCHAR(30) NOT NULL DEFAULT 'Unpaid',
  payment_date DATE DEFAULT NULL,
  payment_reference VARCHAR(120) DEFAULT NULL,
  irn_reference VARCHAR(120) DEFAULT NULL,
  eway_bill_no VARCHAR(60) DEFAULT NULL,
  credit_debit_note_ref VARCHAR(120) DEFAULT NULL,
  notes TEXT,
  invoice_status VARCHAR(30) NOT NULL DEFAULT 'Draft',
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_invoice_id (invoice_id),
  KEY idx_si_date (invoice_date),
  KEY idx_si_client (client_name),
  KEY idx_si_payment (payment_status),
  KEY idx_si_status (invoice_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The INV prefix is already seeded by 2026-09-01-add-automatic-record-ids.sql,
-- but keep this idempotent in case migrations run out of order.
INSERT INTO record_id_sequences (prefix, next_number) VALUES ('INV', 0)
ON DUPLICATE KEY UPDATE prefix = VALUES(prefix);



-- FILE: 2026-09-07-add-finance-dedicated-tables.sql
-- Dedicated Finance sub-module tables.
--
-- The config-driven Finance modules (lib/finance-module-configs.ts + lib/finance-crud.ts)
-- read/write one dedicated table per module, but only the shared `finance_records`
-- table existed. This migration creates every table the CRUD factory targets, with
-- columns that match each ModuleConfig's field keys (and the pasted field spec) plus
-- the system columns the factory writes: created_by, created_at, updated_at, and the
-- tracking columns (tracking_id / opened / open_count) for modules with trackingId.
--
-- Column type conventions (mirrors 2026-09-06-add-sales-invoices.sql):
--   ids .................. VARCHAR(40)
--   names ................ VARCHAR(190)
--   money / amounts ...... DECIMAL(14,2)
--   percentages / rates .. DECIMAL(6,2)
--   checkboxes ........... TINYINT(1) DEFAULT 0
--   selects / short text . VARCHAR(40-120)
--   long text ............ TEXT

-- ---------------------------------------------------------------------------
-- 1. Purchase Bills  (manual PO Number id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_bills (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  po_number VARCHAR(60) NOT NULL,
  bill_date DATE DEFAULT NULL,
  bill_type VARCHAR(40) DEFAULT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  vendor_id VARCHAR(40) DEFAULT NULL,
  vendor_name VARCHAR(190) DEFAULT NULL,
  project_id VARCHAR(40) DEFAULT NULL,
  project_name VARCHAR(190) DEFAULT NULL,
  description TEXT,
  hsn_sac VARCHAR(20) DEFAULT NULL,
  quantity DECIMAL(14,2) NOT NULL DEFAULT 0,
  unit VARCHAR(20) DEFAULT NULL,
  rate DECIMAL(14,2) NOT NULL DEFAULT 0,
  taxable_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
  sgst_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
  igst_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
  other_tax_cess DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  gross_bill_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds_applicable TINYINT(1) NOT NULL DEFAULT 0,
  tds_section VARCHAR(20) DEFAULT NULL,
  tds_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
  tds_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_payable DECIMAL(14,2) NOT NULL DEFAULT 0,
  outstanding_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  due_date DATE DEFAULT NULL,
  amount_paid DECIMAL(14,2) NOT NULL DEFAULT 0,
  payment_status VARCHAR(30) NOT NULL DEFAULT 'Unpaid',
  payment_date DATE DEFAULT NULL,
  payment_reference VARCHAR(120) DEFAULT NULL,
  itc_eligible TINYINT(1) NOT NULL DEFAULT 0,
  itc_claimed TINYINT(1) NOT NULL DEFAULT 0,
  notes TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_po (po_number),
  KEY idx_pb_date (bill_date),
  KEY idx_pb_fy (financial_year),
  KEY idx_pb_vendor (vendor_name),
  KEY idx_pb_status (payment_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. Expenses  (EXP-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  expense_id VARCHAR(40) NOT NULL,
  expense_date DATE DEFAULT NULL,
  expense_type VARCHAR(40) DEFAULT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  party_id VARCHAR(40) DEFAULT NULL,
  party_name VARCHAR(190) DEFAULT NULL,
  project_id VARCHAR(40) DEFAULT NULL,
  project_name VARCHAR(190) DEFAULT NULL,
  expense_category VARCHAR(120) DEFAULT NULL,
  expense_head VARCHAR(120) DEFAULT NULL,
  description TEXT,
  bill_receipt_no VARCHAR(80) DEFAULT NULL,
  payment_mode VARCHAR(40) DEFAULT NULL,
  bank_cash_account_id VARCHAR(40) DEFAULT NULL,
  taxable_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds_applicable TINYINT(1) NOT NULL DEFAULT 0,
  tds_section VARCHAR(20) DEFAULT NULL,
  tds_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
  tds_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  gross_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_payable DECIMAL(14,2) NOT NULL DEFAULT 0,
  approval_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  approved_by VARCHAR(190) DEFAULT NULL,
  reimbursement_status VARCHAR(30) DEFAULT NULL,
  payment_date DATE DEFAULT NULL,
  payment_reference VARCHAR(120) DEFAULT NULL,
  gst_credit_eligible TINYINT(1) NOT NULL DEFAULT 0,
  cost_centre VARCHAR(120) DEFAULT NULL,
  notes TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_id (expense_id),
  KEY idx_exp_date (expense_date),
  KEY idx_exp_fy (financial_year),
  KEY idx_exp_party (party_name),
  KEY idx_exp_status (approval_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. FTE Invoices  (FTE-#### id, tracking enabled)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fte_invoices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  fte_invoice_id VARCHAR(40) NOT NULL,
  invoice_date DATE DEFAULT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  month VARCHAR(20) DEFAULT NULL,
  employee_id VARCHAR(40) DEFAULT NULL,
  employee_name VARCHAR(190) DEFAULT NULL,
  employment_type VARCHAR(40) DEFAULT NULL,
  department VARCHAR(120) DEFAULT NULL,
  designation VARCHAR(120) DEFAULT NULL,
  project_id VARCHAR(40) DEFAULT NULL,
  project_name VARCHAR(190) DEFAULT NULL,
  billing_basis VARCHAR(40) DEFAULT NULL,
  working_days DECIMAL(6,2) NOT NULL DEFAULT 0,
  paid_days DECIMAL(6,2) NOT NULL DEFAULT 0,
  leave_days DECIMAL(6,2) NOT NULL DEFAULT 0,
  holiday_days DECIMAL(6,2) NOT NULL DEFAULT 0,
  gross_billing DECIMAL(14,2) NOT NULL DEFAULT 0,
  overtime_extra DECIMAL(14,2) NOT NULL DEFAULT 0,
  bonus_incentive DECIMAL(14,2) NOT NULL DEFAULT 0,
  other_earnings DECIMAL(14,2) NOT NULL DEFAULT 0,
  gross_earnings DECIMAL(14,2) NOT NULL DEFAULT 0,
  pf_deduction DECIMAL(14,2) NOT NULL DEFAULT 0,
  esi_deduction DECIMAL(14,2) NOT NULL DEFAULT 0,
  professional_tax DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds DECIMAL(14,2) NOT NULL DEFAULT 0,
  other_deductions DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_deductions DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_payable DECIMAL(14,2) NOT NULL DEFAULT 0,
  payment_due_date DATE DEFAULT NULL,
  payment_date DATE DEFAULT NULL,
  payment_reference VARCHAR(120) DEFAULT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'Draft',
  notes TEXT,
  tracking_id VARCHAR(64) DEFAULT NULL,
  opened TINYINT(1) NOT NULL DEFAULT 0,
  first_opened_on TIMESTAMP NULL DEFAULT NULL,
  last_opened_on TIMESTAMP NULL DEFAULT NULL,
  open_count INT NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fte_invoice_id (fte_invoice_id),
  KEY idx_fte_date (invoice_date),
  KEY idx_fte_fy (financial_year),
  KEY idx_fte_employee (employee_name),
  KEY idx_fte_status (status),
  KEY idx_fte_tracking (tracking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. Freelance Invoices  (FRL-#### id, tracking enabled)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS freelance_invoices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  freelance_invoice_id VARCHAR(40) NOT NULL,
  invoice_date DATE DEFAULT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  billing_period VARCHAR(60) DEFAULT NULL,
  freelancer_id VARCHAR(40) DEFAULT NULL,
  freelancer_name VARCHAR(190) DEFAULT NULL,
  project_id VARCHAR(40) DEFAULT NULL,
  project_name VARCHAR(190) DEFAULT NULL,
  work_description TEXT,
  units_deliverables DECIMAL(14,2) NOT NULL DEFAULT 0,
  unit VARCHAR(20) DEFAULT NULL,
  rate DECIMAL(14,2) NOT NULL DEFAULT 0,
  gross_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds_applicable TINYINT(1) NOT NULL DEFAULT 0,
  tds_section VARCHAR(20) DEFAULT NULL,
  tds_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
  tds_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  other_adjustment DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_payable DECIMAL(14,2) NOT NULL DEFAULT 0,
  invoice_bill_reference VARCHAR(120) DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  payment_date DATE DEFAULT NULL,
  payment_reference VARCHAR(120) DEFAULT NULL,
  payment_status VARCHAR(30) NOT NULL DEFAULT 'Unpaid',
  approval_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  notes TEXT,
  tracking_id VARCHAR(64) DEFAULT NULL,
  opened TINYINT(1) NOT NULL DEFAULT 0,
  first_opened_on TIMESTAMP NULL DEFAULT NULL,
  last_opened_on TIMESTAMP NULL DEFAULT NULL,
  open_count INT NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_freelance_invoice_id (freelance_invoice_id),
  KEY idx_frl_date (invoice_date),
  KEY idx_frl_fy (financial_year),
  KEY idx_frl_freelancer (freelancer_name),
  KEY idx_frl_status (payment_status),
  KEY idx_frl_tracking (tracking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 5. Bank Transactions  (BTX-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transaction_id VARCHAR(40) NOT NULL,
  transaction_date DATE DEFAULT NULL,
  value_date DATE DEFAULT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  month VARCHAR(20) DEFAULT NULL,
  bank_cash_account_id VARCHAR(40) DEFAULT NULL,
  account_name VARCHAR(190) DEFAULT NULL,
  transaction_type VARCHAR(40) DEFAULT NULL,
  voucher_type VARCHAR(40) DEFAULT NULL,
  reference_no VARCHAR(80) DEFAULT NULL,
  party_id VARCHAR(40) DEFAULT NULL,
  party_name VARCHAR(190) DEFAULT NULL,
  account_head_id VARCHAR(40) DEFAULT NULL,
  account_head VARCHAR(120) DEFAULT NULL,
  project_id VARCHAR(40) DEFAULT NULL,
  project_name VARCHAR(190) DEFAULT NULL,
  debit DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  payment_mode VARCHAR(40) DEFAULT NULL,
  cheque_utr_reference VARCHAR(120) DEFAULT NULL,
  narration TEXT,
  reconciliation_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  reconciliation_date DATE DEFAULT NULL,
  journal_entry_id VARCHAR(40) DEFAULT NULL,
  attachment_link VARCHAR(255) DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bank_transaction_id (transaction_id),
  KEY idx_btx_date (transaction_date),
  KEY idx_btx_fy (financial_year),
  KEY idx_btx_account (account_name),
  KEY idx_btx_status (reconciliation_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 6. Bank & Cash accounts  (ACC-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  finance_account_id VARCHAR(40) NOT NULL,
  account_name VARCHAR(190) DEFAULT NULL,
  account_type VARCHAR(40) DEFAULT NULL,
  bank_name VARCHAR(190) DEFAULT NULL,
  branch VARCHAR(190) DEFAULT NULL,
  account_number VARCHAR(60) DEFAULT NULL,
  ifsc VARCHAR(15) DEFAULT NULL,
  upi_wallet_id VARCHAR(120) DEFAULT NULL,
  currency VARCHAR(10) DEFAULT NULL,
  opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
  opening_balance_date DATE DEFAULT NULL,
  current_book_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
  bank_statement_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
  difference DECIMAL(14,2) NOT NULL DEFAULT 0,
  reconciliation_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  last_reconciliation_date DATE DEFAULT NULL,
  primary_account TINYINT(1) NOT NULL DEFAULT 0,
  active_status VARCHAR(20) NOT NULL DEFAULT 'Active',
  remarks TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_account_id (finance_account_id),
  KEY idx_facc_name (account_name),
  KEY idx_facc_status (reconciliation_status),
  KEY idx_facc_active (active_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 7. Chart of Accounts  (COA-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id VARCHAR(40) NOT NULL,
  account_code VARCHAR(40) DEFAULT NULL,
  account_name VARCHAR(190) DEFAULT NULL,
  account_group VARCHAR(80) DEFAULT NULL,
  account_type VARCHAR(80) DEFAULT NULL,
  parent_account_id VARCHAR(40) DEFAULT NULL,
  nature VARCHAR(40) DEFAULT NULL,
  opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
  opening_balance_type VARCHAR(20) DEFAULT NULL,
  gst_applicable TINYINT(1) NOT NULL DEFAULT 0,
  tds_applicable TINYINT(1) NOT NULL DEFAULT 0,
  tax_category VARCHAR(80) DEFAULT NULL,
  bank_cash_account TINYINT(1) NOT NULL DEFAULT 0,
  reconciliation_required TINYINT(1) NOT NULL DEFAULT 0,
  active_status VARCHAR(20) NOT NULL DEFAULT 'Active',
  effective_from DATE DEFAULT NULL,
  effective_to DATE DEFAULT NULL,
  remarks TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_coa_account_id (account_id),
  KEY idx_coa_code (account_code),
  KEY idx_coa_name (account_name),
  KEY idx_coa_type (account_type),
  KEY idx_coa_group (account_group),
  KEY idx_coa_parent (parent_account_id),
  KEY idx_coa_active (active_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 8. Customers / Vendors  (CV-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers_vendors (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  party_id VARCHAR(40) NOT NULL,
  customer_name VARCHAR(190) DEFAULT NULL,
  legal_name VARCHAR(190) DEFAULT NULL,
  party_type VARCHAR(40) DEFAULT NULL,
  party_category VARCHAR(80) DEFAULT NULL,
  gstin VARCHAR(20) DEFAULT NULL,
  pan VARCHAR(15) DEFAULT NULL,
  tan VARCHAR(15) DEFAULT NULL,
  contact_person VARCHAR(190) DEFAULT NULL,
  official_email VARCHAR(190) DEFAULT NULL,
  invoice_email VARCHAR(190) DEFAULT NULL,
  alternate_email VARCHAR(190) DEFAULT NULL,
  mobile VARCHAR(30) DEFAULT NULL,
  alternate_mobile VARCHAR(30) DEFAULT NULL,
  billing_address TEXT,
  city VARCHAR(120) DEFAULT NULL,
  state VARCHAR(120) DEFAULT NULL,
  state_code VARCHAR(6) DEFAULT NULL,
  pin_code VARCHAR(12) DEFAULT NULL,
  country VARCHAR(80) DEFAULT NULL,
  payment_terms_days VARCHAR(40) DEFAULT NULL,
  credit_limit DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency VARCHAR(10) DEFAULT NULL,
  bank_name VARCHAR(190) DEFAULT NULL,
  bank_branch VARCHAR(190) DEFAULT NULL,
  bank_account_no VARCHAR(60) DEFAULT NULL,
  ifsc VARCHAR(15) DEFAULT NULL,
  account_holder_name VARCHAR(190) DEFAULT NULL,
  tds_section VARCHAR(20) DEFAULT NULL,
  tds_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
  gst_registration_type VARCHAR(40) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  notes TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cv_party_id (party_id),
  KEY idx_cv_name (customer_name),
  KEY idx_cv_gstin (gstin),
  KEY idx_cv_pan (pan),
  KEY idx_cv_city (city),
  KEY idx_cv_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 9. GST Filings  (GST-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gst_filings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  gst_filing_id VARCHAR(40) NOT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  return_period VARCHAR(40) DEFAULT NULL,
  gstin VARCHAR(20) DEFAULT NULL,
  legal_name VARCHAR(190) DEFAULT NULL,
  return_type VARCHAR(40) DEFAULT NULL,
  filing_frequency VARCHAR(40) DEFAULT NULL,
  filing_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  due_date DATE DEFAULT NULL,
  invoice_type VARCHAR(40) DEFAULT NULL,
  supply_category VARCHAR(80) DEFAULT NULL,
  recipient_gstin VARCHAR(20) DEFAULT NULL,
  recipient_name VARCHAR(190) DEFAULT NULL,
  name_as_in_master VARCHAR(190) DEFAULT NULL,
  invoice_number VARCHAR(80) DEFAULT NULL,
  invoice_date DATE DEFAULT NULL,
  total_invoice_value DECIMAL(14,2) NOT NULL DEFAULT 0,
  place_of_supply VARCHAR(80) DEFAULT NULL,
  supply_type VARCHAR(40) DEFAULT NULL,
  tax_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
  taxable_value DECIMAL(14,2) NOT NULL DEFAULT 0,
  cess_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_tax DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_eligible TINYINT(1) NOT NULL DEFAULT 0,
  itc_igst DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_cgst DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_sgst DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_cess DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_reversal DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_itc DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds DECIMAL(14,2) NOT NULL DEFAULT 0,
  tcs DECIMAL(14,2) NOT NULL DEFAULT 0,
  interest DECIMAL(14,2) NOT NULL DEFAULT 0,
  late_fee DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_liability DECIMAL(14,2) NOT NULL DEFAULT 0,
  payment_required TINYINT(1) NOT NULL DEFAULT 0,
  payment_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  payment_date DATE DEFAULT NULL,
  challan_cin VARCHAR(120) DEFAULT NULL,
  validation_status VARCHAR(30) DEFAULT NULL,
  validation_error_count INT NOT NULL DEFAULT 0,
  validation_message TEXT,
  arn VARCHAR(60) DEFAULT NULL,
  filing_date DATE DEFAULT NULL,
  document_link VARCHAR(255) DEFAULT NULL,
  remarks TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gst_filing_id (gst_filing_id),
  KEY idx_gst_due (due_date),
  KEY idx_gst_fy (financial_year),
  KEY idx_gst_gstin (gstin),
  KEY idx_gst_status (filing_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 10. TDS Filings  (TDS-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tds_filings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tds_filing_id VARCHAR(40) NOT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  quarter VARCHAR(20) DEFAULT NULL,
  month VARCHAR(20) DEFAULT NULL,
  tan VARCHAR(15) DEFAULT NULL,
  invoice_id VARCHAR(40) DEFAULT NULL,
  deductee_id VARCHAR(40) DEFAULT NULL,
  deductee_name VARCHAR(190) DEFAULT NULL,
  pan VARCHAR(15) DEFAULT NULL,
  section VARCHAR(20) DEFAULT NULL,
  payment_type VARCHAR(40) DEFAULT NULL,
  gross_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
  tds_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  interest DECIMAL(14,2) NOT NULL DEFAULT 0,
  late_fee DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_liability DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds_paid DECIMAL(14,2) NOT NULL DEFAULT 0,
  balance_payable_refund DECIMAL(14,2) NOT NULL DEFAULT 0,
  challan_no VARCHAR(80) DEFAULT NULL,
  challan_date DATE DEFAULT NULL,
  payment_reference VARCHAR(120) DEFAULT NULL,
  return_type VARCHAR(40) DEFAULT NULL,
  filing_due_date DATE DEFAULT NULL,
  filing_date DATE DEFAULT NULL,
  acknowledgement_no VARCHAR(80) DEFAULT NULL,
  return_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  correction_required TINYINT(1) NOT NULL DEFAULT 0,
  correction_date DATE DEFAULT NULL,
  remarks TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tds_filing_id (tds_filing_id),
  KEY idx_tds_due (filing_due_date),
  KEY idx_tds_fy (financial_year),
  KEY idx_tds_deductee (deductee_name),
  KEY idx_tds_status (return_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Seed automatic record-id prefixes used by these modules (idempotent).
-- Purchase Bills use a manually entered PO Number, so no prefix is seeded.
-- ---------------------------------------------------------------------------
INSERT INTO record_id_sequences (prefix, next_number) VALUES
  ('EXP', 0), ('FTE', 0), ('FRL', 0), ('BTX', 0),
  ('ACC', 0), ('COA', 0), ('CV', 0), ('GST', 0), ('TDS', 0)
ON DUPLICATE KEY UPDATE prefix = VALUES(prefix);



-- FILE: 2026-09-08-add-journal-ledger-reports.sql
-- Journal Entries, General Ledger and Financial Reports.
--
-- Adds the two dedicated tables the config-driven CRUD factory targets for the
-- "journal-entries" and "general-ledger" Finance modules (matching the field
-- keys in lib/finance-module-configs.ts and the pasted column spec), plus a
-- lightweight saved-report log for the Financial Reports hub.
--
-- Column type conventions mirror 2026-09-07-add-finance-dedicated-tables.sql:
--   ids .................. VARCHAR(40)
--   names ................ VARCHAR(190)
--   money / amounts ...... DECIMAL(14,2)
--   selects / short text . VARCHAR(40-120)
--   long text ............ TEXT

-- ---------------------------------------------------------------------------
-- 1. Journal Entries  (JE-#### id, editable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  journal_entry_id VARCHAR(40) NOT NULL,
  journal_date DATE DEFAULT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  reference_type VARCHAR(40) DEFAULT NULL,
  reference_no VARCHAR(80) DEFAULT NULL,
  voucher_type VARCHAR(40) DEFAULT NULL,
  narration TEXT,
  account_id VARCHAR(40) DEFAULT NULL,
  account_name VARCHAR(190) DEFAULT NULL,
  account_group VARCHAR(80) DEFAULT NULL,
  account_type VARCHAR(80) DEFAULT NULL,
  party_id VARCHAR(40) DEFAULT NULL,
  party_name VARCHAR(190) DEFAULT NULL,
  project_id VARCHAR(40) DEFAULT NULL,
  project_name VARCHAR(190) DEFAULT NULL,
  debit DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  payment_mode VARCHAR(40) DEFAULT NULL,
  cheque_utr_reference VARCHAR(120) DEFAULT NULL,
  source_module VARCHAR(60) DEFAULT NULL,
  source_reference VARCHAR(120) DEFAULT NULL,
  approval_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
  approved_by VARCHAR(190) DEFAULT NULL,
  posting_status VARCHAR(30) NOT NULL DEFAULT 'Unposted',
  posting_date DATE DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_journal_entry_id (journal_entry_id),
  KEY idx_je_date (journal_date),
  KEY idx_je_fy (financial_year),
  KEY idx_je_account (account_name),
  KEY idx_je_status (approval_status),
  KEY idx_je_posting (posting_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. General Ledger  (GL-#### id, editable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS general_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ledger_id VARCHAR(40) NOT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  transaction_date DATE DEFAULT NULL,
  value_date DATE DEFAULT NULL,
  month VARCHAR(20) DEFAULT NULL,
  account_id VARCHAR(40) DEFAULT NULL,
  account_name VARCHAR(190) DEFAULT NULL,
  account_group VARCHAR(80) DEFAULT NULL,
  account_type VARCHAR(80) DEFAULT NULL,
  transaction_type VARCHAR(40) DEFAULT NULL,
  voucher_type VARCHAR(40) DEFAULT NULL,
  reference_no VARCHAR(80) DEFAULT NULL,
  party_id VARCHAR(40) DEFAULT NULL,
  party_name VARCHAR(190) DEFAULT NULL,
  project_id VARCHAR(40) DEFAULT NULL,
  project_name VARCHAR(190) DEFAULT NULL,
  description TEXT,
  debit DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  gst_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  tds_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  balance DECIMAL(14,2) NOT NULL DEFAULT 0,
  balance_type VARCHAR(20) DEFAULT NULL,
  payment_mode VARCHAR(40) DEFAULT NULL,
  cheque_utr_reference VARCHAR(120) DEFAULT NULL,
  source_module VARCHAR(60) DEFAULT NULL,
  source_reference VARCHAR(120) DEFAULT NULL,
  reconciliation_status VARCHAR(30) NOT NULL DEFAULT 'Unreconciled',
  reconciliation_date DATE DEFAULT NULL,
  journal_entry_id VARCHAR(40) DEFAULT NULL,
  attachment_link VARCHAR(255) DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_id (ledger_id),
  KEY idx_gl_date (transaction_date),
  KEY idx_gl_fy (financial_year),
  KEY idx_gl_account (account_name),
  KEY idx_gl_status (reconciliation_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Seed automatic record-id prefixes for the new modules (idempotent).
-- ---------------------------------------------------------------------------
INSERT INTO record_id_sequences (prefix, next_number) VALUES
  ('JE', 0), ('GL', 0)
ON DUPLICATE KEY UPDATE prefix = VALUES(prefix);



-- FILE: 2026-09-08-add-personal-notes.sql
-- Personal notes / daily tasks (Google Keep style).
-- Each note belongs to one user (users.id via session.userId). Employees jot
-- their daily tasks, tick them off when done, and can edit or delete them.
-- The /api/notes route also creates this table on first use, so running this
-- migration by hand is optional.
CREATE TABLE IF NOT EXISTS `personal_notes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `content` TEXT NOT NULL,
  `color` VARCHAR(20) NOT NULL DEFAULT 'default',
  `completed` TINYINT(1) NOT NULL DEFAULT 0,
  `completed_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_personal_notes_user` (`user_id`),
  KEY `idx_personal_notes_user_completed` (`user_id`, `completed`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;



-- FILE: 2026-09-09-add-recruitment-module.sql
-- Recruitment module: dedicated sub-module tables + sidebar feature slugs.
--
-- The config-driven Recruitment modules (lib/recruitment-module-configs.ts +
-- lib/recruitment-crud.ts) read/write one dedicated table per module, but none
-- of those tables existed yet. This migration creates every table the CRUD
-- factory targets, with columns that match each ModuleConfig's field keys plus
-- the system columns the factory writes (created_by, created_at, updated_at)
-- and the email tracking columns for the modules that declare them.
--
-- It also registers the permission-gated features referenced by the sidebar
-- dropdown (app/(workspace)/layout.tsx -> RECRUITMENT_CHILDREN) so the module
-- appears for non-admins and admins can grant granular access.
--
-- Column type conventions (mirror 2026-09-07-add-finance-dedicated-tables.sql):
--   ids ................. VARCHAR(40)
--   names / short text .. VARCHAR(190)
--   selects ............. VARCHAR(40)
--   money ............... DECIMAL(14,2)
--   scores / rates / % .. DECIMAL(6,2)
--   counts .............. INT
--   long text ........... TEXT
--   urls ................ VARCHAR(255)

-- ---------------------------------------------------------------------------
-- 1. Job Requisitions  (REQ-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_requisitions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  requisition_id VARCHAR(40) NOT NULL,
  requisition_date DATE DEFAULT NULL,
  job_title VARCHAR(190) DEFAULT NULL,
  department VARCHAR(190) DEFAULT NULL,
  project VARCHAR(190) DEFAULT NULL,
  employment_type VARCHAR(40) DEFAULT NULL,
  required_resources INT NOT NULL DEFAULT 0,
  filled_resources INT NOT NULL DEFAULT 0,
  pending_resources INT NOT NULL DEFAULT 0,
  priority VARCHAR(40) DEFAULT NULL,
  required_qualification VARCHAR(190) DEFAULT NULL,
  required_skills TEXT,
  experience_required VARCHAR(190) DEFAULT NULL,
  location VARCHAR(190) DEFAULT NULL,
  work_mode VARCHAR(40) DEFAULT NULL,
  rate_salary VARCHAR(120) DEFAULT NULL,
  hiring_manager VARCHAR(190) DEFAULT NULL,
  recruiter VARCHAR(190) DEFAULT NULL,
  target_date DATE DEFAULT NULL,
  status VARCHAR(40) DEFAULT NULL,
  remarks TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_req_id (requisition_id),
  KEY idx_req_date (requisition_date),
  KEY idx_req_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. Recruitment Campaigns  (CAM-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_campaigns (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id VARCHAR(40) NOT NULL,
  campaign_name VARCHAR(190) DEFAULT NULL,
  job_title VARCHAR(190) DEFAULT NULL,
  requisition_id VARCHAR(40) DEFAULT NULL,
  recruitment_source VARCHAR(190) DEFAULT NULL,
  recruiter VARCHAR(190) DEFAULT NULL,
  google_form_url VARCHAR(255) DEFAULT NULL,
  form_response_sheet VARCHAR(255) DEFAULT NULL,
  form_created_date DATE DEFAULT NULL,
  campaign_start_date DATE DEFAULT NULL,
  campaign_end_date DATE DEFAULT NULL,
  target_applications INT NOT NULL DEFAULT 0,
  applications_received INT NOT NULL DEFAULT 0,
  shortlisted INT NOT NULL DEFAULT 0,
  interviewed INT NOT NULL DEFAULT 0,
  selected INT NOT NULL DEFAULT 0,
  joined INT NOT NULL DEFAULT 0,
  campaign_status VARCHAR(40) DEFAULT NULL,
  remarks TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cam_id (campaign_id),
  KEY idx_cam_date (campaign_start_date),
  KEY idx_cam_status (campaign_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. Candidate Master  (CAND-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_candidates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  candidate_id VARCHAR(40) NOT NULL,
  application_date DATE DEFAULT NULL,
  candidate_name VARCHAR(190) DEFAULT NULL,
  email VARCHAR(190) DEFAULT NULL,
  mobile VARCHAR(30) DEFAULT NULL,
  alternate_mobile VARCHAR(30) DEFAULT NULL,
  current_location VARCHAR(190) DEFAULT NULL,
  preferred_location VARCHAR(190) DEFAULT NULL,
  job_applied VARCHAR(190) DEFAULT NULL,
  requisition_id VARCHAR(40) DEFAULT NULL,
  campaign_id VARCHAR(40) DEFAULT NULL,
  source VARCHAR(120) DEFAULT NULL,
  form_link VARCHAR(255) DEFAULT NULL,
  form_response_link VARCHAR(255) DEFAULT NULL,
  employment_type VARCHAR(40) DEFAULT NULL,
  experience VARCHAR(120) DEFAULT NULL,
  highest_qualification VARCHAR(190) DEFAULT NULL,
  primary_skills TEXT,
  secondary_skills TEXT,
  current_company VARCHAR(190) DEFAULT NULL,
  current_ctc VARCHAR(60) DEFAULT NULL,
  expected_ctc_rate VARCHAR(60) DEFAULT NULL,
  notice_period VARCHAR(60) DEFAULT NULL,
  resume_url VARCHAR(255) DEFAULT NULL,
  portfolio_url VARCHAR(255) DEFAULT NULL,
  linkedin_url VARCHAR(255) DEFAULT NULL,
  candidate_status VARCHAR(40) DEFAULT NULL,
  remarks TEXT,
  source_spreadsheet VARCHAR(190) DEFAULT NULL,
  source_sheet VARCHAR(120) DEFAULT NULL,
  source_row INT DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cand_id (candidate_id),
  KEY idx_cand_date (application_date),
  KEY idx_cand_status (candidate_status),
  KEY idx_cand_name (candidate_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. Screening  (SCR-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_screening (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  screening_id VARCHAR(40) NOT NULL,
  candidate_id VARCHAR(40) DEFAULT NULL,
  candidate_name VARCHAR(190) DEFAULT NULL,
  job_applied VARCHAR(190) DEFAULT NULL,
  requisition_id VARCHAR(40) DEFAULT NULL,
  screening_date DATE DEFAULT NULL,
  recruiter VARCHAR(190) DEFAULT NULL,
  qualification_match DECIMAL(6,2) NOT NULL DEFAULT 0,
  experience_match DECIMAL(6,2) NOT NULL DEFAULT 0,
  skill_match DECIMAL(6,2) NOT NULL DEFAULT 0,
  communication DECIMAL(6,2) NOT NULL DEFAULT 0,
  availability DECIMAL(6,2) NOT NULL DEFAULT 0,
  rate_salary_fit DECIMAL(6,2) NOT NULL DEFAULT 0,
  overall_score DECIMAL(6,2) NOT NULL DEFAULT 0,
  screening_result VARCHAR(40) DEFAULT NULL,
  status VARCHAR(40) DEFAULT NULL,
  reason_for_rejection VARCHAR(255) DEFAULT NULL,
  next_action VARCHAR(190) DEFAULT NULL,
  next_action_date DATE DEFAULT NULL,
  remarks TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_scr_id (screening_id),
  KEY idx_scr_date (screening_date),
  KEY idx_scr_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 5. Interview Tracker  (INT-#### id, email tracking enabled)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_interviews (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  interview_id VARCHAR(40) NOT NULL,
  candidate_id VARCHAR(40) DEFAULT NULL,
  candidate_name VARCHAR(190) DEFAULT NULL,
  job_applied VARCHAR(190) DEFAULT NULL,
  requisition_id VARCHAR(40) DEFAULT NULL,
  interview_round VARCHAR(120) DEFAULT NULL,
  interview_type VARCHAR(40) DEFAULT NULL,
  interviewer VARCHAR(190) DEFAULT NULL,
  interview_date DATE DEFAULT NULL,
  interview_time VARCHAR(40) DEFAULT NULL,
  interview_link_location VARCHAR(255) DEFAULT NULL,
  attendance VARCHAR(40) DEFAULT NULL,
  technical_score DECIMAL(6,2) NOT NULL DEFAULT 0,
  communication_score DECIMAL(6,2) NOT NULL DEFAULT 0,
  subject_score DECIMAL(6,2) NOT NULL DEFAULT 0,
  overall_score DECIMAL(6,2) NOT NULL DEFAULT 0,
  interview_result VARCHAR(40) DEFAULT NULL,
  feedback TEXT,
  next_round VARCHAR(120) DEFAULT NULL,
  next_interview_date DATE DEFAULT NULL,
  recruiter VARCHAR(190) DEFAULT NULL,
  email_status VARCHAR(120) DEFAULT NULL,
  remarks TEXT,
  tracking_id VARCHAR(64) DEFAULT NULL,
  opened VARCHAR(10) DEFAULT NULL,
  first_opened_on DATE DEFAULT NULL,
  last_opened_on DATE DEFAULT NULL,
  open_count INT NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_int_id (interview_id),
  KEY idx_int_date (interview_date),
  KEY idx_int_result (interview_result),
  KEY idx_int_tracking (tracking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 6. Assessment Tracker  (ASM-#### id, email tracking enabled)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_assessments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  assessment_id VARCHAR(40) NOT NULL,
  candidate_id VARCHAR(40) DEFAULT NULL,
  candidate_name VARCHAR(190) DEFAULT NULL,
  job_applied VARCHAR(190) DEFAULT NULL,
  assessment_type VARCHAR(120) DEFAULT NULL,
  assessment_sent_date DATE DEFAULT NULL,
  submission_deadline DATE DEFAULT NULL,
  submission_date DATE DEFAULT NULL,
  assessment_link VARCHAR(255) DEFAULT NULL,
  score DECIMAL(6,2) NOT NULL DEFAULT 0,
  maximum_score DECIMAL(6,2) NOT NULL DEFAULT 0,
  percentage DECIMAL(6,2) NOT NULL DEFAULT 0,
  qc_score DECIMAL(6,2) NOT NULL DEFAULT 0,
  assessment_result VARCHAR(40) DEFAULT NULL,
  evaluator VARCHAR(190) DEFAULT NULL,
  feedback TEXT,
  status VARCHAR(40) DEFAULT NULL,
  remarks TEXT,
  tracking_id VARCHAR(64) DEFAULT NULL,
  opened VARCHAR(10) DEFAULT NULL,
  first_opened_on DATE DEFAULT NULL,
  last_opened_on DATE DEFAULT NULL,
  open_count INT NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_asm_id (assessment_id),
  KEY idx_asm_date (assessment_sent_date),
  KEY idx_asm_status (status),
  KEY idx_asm_tracking (tracking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 7. Selection & Offers  (SEL-#### id, email tracking enabled)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_selections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  selection_id VARCHAR(40) NOT NULL,
  candidate_id VARCHAR(40) DEFAULT NULL,
  candidate_name VARCHAR(190) DEFAULT NULL,
  job_applied VARCHAR(190) DEFAULT NULL,
  requisition_id VARCHAR(40) DEFAULT NULL,
  selection_date DATE DEFAULT NULL,
  selected_by VARCHAR(190) DEFAULT NULL,
  employment_type VARCHAR(40) DEFAULT NULL,
  offered_salary_rate VARCHAR(120) DEFAULT NULL,
  final_salary_rate VARCHAR(120) DEFAULT NULL,
  offer_date DATE DEFAULT NULL,
  offer_sent VARCHAR(10) DEFAULT NULL,
  offer_accepted VARCHAR(10) DEFAULT NULL,
  offer_acceptance_date DATE DEFAULT NULL,
  joining_date DATE DEFAULT NULL,
  offer_status VARCHAR(40) DEFAULT NULL,
  joining_status VARCHAR(40) DEFAULT NULL,
  reason_for_drop VARCHAR(255) DEFAULT NULL,
  recruiter VARCHAR(190) DEFAULT NULL,
  remarks TEXT,
  tracking_id VARCHAR(64) DEFAULT NULL,
  opened VARCHAR(10) DEFAULT NULL,
  first_opened_on DATE DEFAULT NULL,
  last_opened_on DATE DEFAULT NULL,
  open_count INT NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sel_id (selection_id),
  KEY idx_sel_date (selection_date),
  KEY idx_sel_offer (offer_status),
  KEY idx_sel_tracking (tracking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 8. Recruitment Sources  (SRC-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_sources (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id VARCHAR(40) NOT NULL,
  source_name VARCHAR(190) DEFAULT NULL,
  source_type VARCHAR(40) DEFAULT NULL,
  source_url VARCHAR(255) DEFAULT NULL,
  contact_person VARCHAR(190) DEFAULT NULL,
  contact_email VARCHAR(190) DEFAULT NULL,
  contact_mobile VARCHAR(30) DEFAULT NULL,
  cost DECIMAL(14,2) NOT NULL DEFAULT 0,
  applications INT NOT NULL DEFAULT 0,
  shortlisted INT NOT NULL DEFAULT 0,
  selected INT NOT NULL DEFAULT 0,
  joined INT NOT NULL DEFAULT 0,
  conversion_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
  status VARCHAR(40) DEFAULT NULL,
  remarks TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_src_id (source_id),
  KEY idx_src_type (source_type),
  KEY idx_src_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 9. Recruitment Settings  (SET-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  setting_id VARCHAR(40) NOT NULL,
  setting_category VARCHAR(120) DEFAULT NULL,
  setting_name VARCHAR(190) DEFAULT NULL,
  setting_value VARCHAR(255) DEFAULT NULL,
  description TEXT,
  active VARCHAR(10) DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_set_id (setting_id),
  KEY idx_set_category (setting_category),
  KEY idx_set_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Sidebar dropdown wiring: ensure the Recruitment module + its feature slugs
-- exist so the dropdown resolves for non-admins and can be granted per user.
-- Idempotent (INSERT IGNORE relies on uniq_modules_slug / uniq_feature_slug).
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO modules (name, slug, description, icon, sort_order)
SELECT 'Recruitment', 'recruitment', 'Requisitions, candidates, interviews, offers and sourcing analytics.', 'user-plus', 4
FROM dual WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'recruitment');

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Recruitment Dashboard', 'recruitment.view_dashboard', 'View the recruitment dashboard', 1 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Job Requisitions', 'recruitment.view_requisitions', 'View and manage job requisitions', 2 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Recruitment Campaigns', 'recruitment.view_campaigns', 'View and manage sourcing campaigns', 3 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Candidate Master', 'recruitment.view_candidates', 'View the candidate database', 4 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Screening', 'recruitment.view_screening', 'View and record candidate screening', 5 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Interview Tracker', 'recruitment.schedule_interviews', 'Schedule and track interviews', 6 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Assessment Tracker', 'recruitment.view_assessments', 'View and evaluate assessments', 7 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Selection & Offers', 'recruitment.manage_offers', 'Manage selections, offers and joining', 8 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Recruitment Sources', 'recruitment.view_sources', 'View sourcing channel performance', 9 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Recruitment Settings', 'recruitment.view_settings', 'View and manage recruitment master lists', 10 FROM modules WHERE slug = 'recruitment';



-- FILE: 2026-09-09-expand-operations-fields.sql
-- Expand Operations module tables with full field sets.
-- Target: Hostinger MySQL. Run ONCE (MySQL does not support ADD COLUMN IF NOT EXISTS).
-- Adds detailed columns for Resources, Projects, Allocations, Quality & SLA Reviews, Issues.

-- ---------------------------------------------------------------------------
-- Resources
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_resources`
  ADD COLUMN `department`          VARCHAR(120)    NULL AFTER `resource_type`,
  ADD COLUMN `designation`         VARCHAR(120)    NULL AFTER `department`,
  ADD COLUMN `skill_category`      VARCHAR(120)    NULL AFTER `designation`,
  ADD COLUMN `primary_skills`      VARCHAR(500)    NULL AFTER `skill_category`,
  ADD COLUMN `secondary_skills`    VARCHAR(500)    NULL AFTER `primary_skills`,
  ADD COLUMN `employment_status`   VARCHAR(60)     NULL AFTER `secondary_skills`,
  ADD COLUMN `joining_date`        DATE            NULL AFTER `employment_status`,
  ADD COLUMN `exit_date`           DATE            NULL AFTER `joining_date`,
  ADD COLUMN `current_location`    VARCHAR(160)    NULL AFTER `exit_date`,
  ADD COLUMN `work_mode`           VARCHAR(40)     NULL AFTER `current_location`,
  ADD COLUMN `availability_status` VARCHAR(60)     NULL AFTER `work_mode`,
  ADD COLUMN `cost_rate`           DECIMAL(12,2)   NULL AFTER `availability_status`,
  ADD COLUMN `rate_type`           VARCHAR(40)     NULL AFTER `cost_rate`,
  ADD COLUMN `reporting_manager`   VARCHAR(160)    NULL AFTER `rate_type`,
  ADD COLUMN `personal_email`      VARCHAR(190)    NULL AFTER `reporting_manager`,
  ADD COLUMN `official_email`      VARCHAR(190)    NULL AFTER `personal_email`,
  ADD COLUMN `contact_mobile`      VARCHAR(40)     NULL AFTER `official_email`,
  ADD COLUMN `vendor_agency`       VARCHAR(160)    NULL AFTER `contact_mobile`,
  ADD COLUMN `shift`               VARCHAR(60)     NULL AFTER `vendor_agency`,
  ADD COLUMN `remarks`             TEXT            NULL AFTER `shift`;

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_projects`
  ADD COLUMN `client_id`            VARCHAR(60)   NULL AFTER `project_id`,
  ADD COLUMN `service_vertical`     VARCHAR(160)  NULL AFTER `project_name`,
  ADD COLUMN `project_type`         VARCHAR(120)  NULL AFTER `service_vertical`,
  ADD COLUMN `project_manager`      VARCHAR(160)  NULL AFTER `project_type`,
  ADD COLUMN `operations_manager`   VARCHAR(160)  NULL AFTER `project_manager`,
  ADD COLUMN `billing_model`        VARCHAR(120)  NULL AFTER `end_date`,
  ADD COLUMN `required_resources`   INT           NULL AFTER `billing_model`,
  ADD COLUMN `allocated_resources`  INT           NULL AFTER `required_resources`,
  ADD COLUMN `resources_deficiency` INT           NULL AFTER `allocated_resources`,
  ADD COLUMN `sla_target`           VARCHAR(160)  NULL AFTER `resources_deficiency`,
  ADD COLUMN `shift`                VARCHAR(60)   NULL AFTER `priority`,
  ADD COLUMN `work_mode`            VARCHAR(40)   NULL AFTER `shift`,
  ADD COLUMN `client_poc`           VARCHAR(160)  NULL AFTER `work_mode`,
  ADD COLUMN `client_email`         VARCHAR(190)  NULL AFTER `client_poc`,
  ADD COLUMN `client_contact`       VARCHAR(60)   NULL AFTER `client_email`,
  ADD COLUMN `remarks`              TEXT          NULL AFTER `description`,
  ADD COLUMN `updated_at`           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;

-- ---------------------------------------------------------------------------
-- Allocations
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_allocations`
  ADD COLUMN `resource_name`       VARCHAR(160)   NULL AFTER `resource_id`,
  ADD COLUMN `resource_type`       VARCHAR(60)    NULL AFTER `resource_name`,
  ADD COLUMN `client_name`         VARCHAR(190)   NULL AFTER `project_id`,
  ADD COLUMN `role`                VARCHAR(160)   NULL AFTER `client_name`,
  ADD COLUMN `shift`               VARCHAR(60)    NULL AFTER `to_date`,
  ADD COLUMN `working_capacity`    DECIMAL(8,2)   NULL AFTER `shift`,
  ADD COLUMN `allocated_capacity`  DECIMAL(8,2)   NULL AFTER `working_capacity`,
  ADD COLUMN `available_capacity`  DECIMAL(8,2)   NULL AFTER `allocated_capacity`,
  ADD COLUMN `project_manager`     VARCHAR(160)   NULL AFTER `status`,
  ADD COLUMN `operations_manager`  VARCHAR(160)   NULL AFTER `project_manager`,
  ADD COLUMN `remarks`             TEXT           NULL AFTER `notes`,
  ADD COLUMN `updated_at`          TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;

-- ---------------------------------------------------------------------------
-- Quality & SLA Reviews
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_quality_reviews`
  ADD COLUMN `task_id`            VARCHAR(60)    NULL AFTER `review_id`,
  ADD COLUMN `client_name`        VARCHAR(190)   NULL AFTER `project_id`,
  ADD COLUMN `resource_name`      VARCHAR(160)   NULL AFTER `resource_id`,
  ADD COLUMN `resource_type`      VARCHAR(60)    NULL AFTER `resource_name`,
  ADD COLUMN `quality_target`     DECIMAL(5,2)   NULL AFTER `quality_score`,
  ADD COLUMN `error_rate`         DECIMAL(5,2)   NULL AFTER `quality_target`,
  ADD COLUMN `rework_count`       INT            NULL AFTER `error_rate`,
  ADD COLUMN `sla_target`         VARCHAR(160)   NULL AFTER `rework_count`,
  ADD COLUMN `sla_actual`         VARCHAR(160)   NULL AFTER `sla_target`,
  ADD COLUMN `sla_status`         VARCHAR(60)    NULL AFTER `sla_actual`,
  ADD COLUMN `client_escalation`  VARCHAR(120)   NULL AFTER `sla_status`,
  ADD COLUMN `root_cause`         TEXT           NULL AFTER `client_escalation`,
  ADD COLUMN `corrective_action`  TEXT           NULL AFTER `root_cause`,
  ADD COLUMN `action_owner`       VARCHAR(160)   NULL AFTER `corrective_action`,
  ADD COLUMN `action_due_date`    DATE           NULL AFTER `action_owner`,
  ADD COLUMN `closure_date`       DATE           NULL AFTER `action_due_date`,
  ADD COLUMN `updated_at`         TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;

-- ---------------------------------------------------------------------------
-- Issues
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_issues`
  ADD COLUMN `date_reported`      DATE           NULL AFTER `issue_id`,
  ADD COLUMN `client_name`        VARCHAR(190)   NULL AFTER `project_id`,
  ADD COLUMN `issue_type`         VARCHAR(120)   NULL AFTER `client_name`,
  ADD COLUMN `issue_category`     VARCHAR(120)   NULL AFTER `issue_type`,
  ADD COLUMN `impact`             VARCHAR(255)   NULL AFTER `description`,
  ADD COLUMN `reported_by`        VARCHAR(160)   NULL AFTER `impact`,
  ADD COLUMN `root_cause`         TEXT           NULL AFTER `assigned_to`,
  ADD COLUMN `corrective_action`  TEXT           NULL AFTER `root_cause`,
  ADD COLUMN `preventive_action`  TEXT           NULL AFTER `corrective_action`,
  ADD COLUMN `target_date`        DATE           NULL AFTER `preventive_action`,
  ADD COLUMN `closure_date`       DATE           NULL AFTER `target_date`,
  ADD COLUMN `escalation_level`   VARCHAR(60)    NULL AFTER `status`,
  ADD COLUMN `client_impact`      VARCHAR(255)   NULL AFTER `escalation_level`,
  ADD COLUMN `business_impact`    VARCHAR(255)   NULL AFTER `client_impact`,
  ADD COLUMN `updated_at`         TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;



-- FILE: 2026-09-10-add-attendance-active-session.sql
-- Adds a column to track the start of the currently open work session so a
-- single day can hold multiple clock-in / clock-out cycles in one row. Worked
-- hours accumulate per session in `working_hours`; the gaps between sessions
-- (breaks) are stored in `break_minutes` and never counted as worked time.
-- The app also creates this column at runtime if it is missing, so running
-- this migration is optional but recommended for fresh setups.
--
-- Idempotent: uses ADD COLUMN IF NOT EXISTS so it re-imports cleanly even when
-- the runtime self-heal already created the column (MariaDB / MySQL 8.0.29+).
ALTER TABLE `hr_attendance` ADD COLUMN IF NOT EXISTS `active_since` DATETIME NULL DEFAULT NULL AFTER `clock_out`;



-- FILE: 2026-09-10-add-hr-attendance-location.sql
-- Adds geolocation columns to hr_attendance for existing databases.
-- The original 2026-09-01-add-hr-attendance.sql uses CREATE TABLE IF NOT EXISTS,
-- so tables that already existed before the location feature never received
-- these columns. Run this once against such databases.
--
-- Idempotent: uses ADD COLUMN IF NOT EXISTS so it re-imports cleanly even when
-- the runtime self-heal already created these columns (MariaDB / MySQL 8.0.29+).
ALTER TABLE `hr_attendance` ADD COLUMN IF NOT EXISTS `location` VARCHAR(180) DEFAULT NULL AFTER `overtime_hours`;
ALTER TABLE `hr_attendance` ADD COLUMN IF NOT EXISTS `latitude` DECIMAL(10,7) DEFAULT NULL AFTER `location`;
ALTER TABLE `hr_attendance` ADD COLUMN IF NOT EXISTS `longitude` DECIMAL(10,7) DEFAULT NULL AFTER `latitude`;



-- FILE: 2026-09-10-add-notice-board.sql
-- Notice Board (matches Worksuite /account/notices)
-- Company announcements addressed to employees or clients, optionally scoped to a department.
CREATE TABLE IF NOT EXISTS notices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  heading VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  to_type ENUM('employees','clients') NOT NULL DEFAULT 'employees',
  department VARCHAR(150) NULL,
  created_by INT NULL,
  created_by_name VARCHAR(150) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_notices_to_type (to_type),
  INDEX idx_notices_created (created_at)
);

-- Feature: manage (create/edit/delete) notices. The base "notice-board.view" feature
-- is already seeded by the workspace-modules migration for read access.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Manage notices', 'notice-board.manage', 'Create, edit and delete company notices', 93
FROM modules WHERE slug = 'notice-board';



-- FILE: 2026-09-10-worksuite-recruit-module.sql
-- Worksuite-style Recruit module.
--
-- Replaces the previous config-driven Recruitment sub-modules (job requisitions,
-- campaigns, screening, etc.) with a Worksuite-parity feature set:
--   Recruit Dashboard, Jobs, Job Applications (Kanban pipeline), Interview
--   Schedule, Job Offer Letter, Job Skills, Candidate Database and Report,
--   plus public Careers / Job Opening pages with an apply form that supports
--   per-job custom questions.
--
-- Column type conventions mirror the finance/recruitment migrations:
--   ids ......... VARCHAR(40)     names / short text .. VARCHAR(190)
--   selects ..... VARCHAR(40)     money ............... DECIMAL(14,2)
--   urls ........ VARCHAR(255)    long text ........... TEXT
--
-- The old recruitment_* tables are intentionally left in place (harmless);
-- this migration only ADDS the new recruit_* tables and re-registers the
-- sidebar features. Run once on the host MySQL database.

-- ---------------------------------------------------------------------------
-- 1. Job Skills  (JSK-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruit_job_skills (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  skill_id VARCHAR(40) NOT NULL,
  name VARCHAR(190) NOT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jsk_id (skill_id),
  UNIQUE KEY uq_jsk_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. Jobs  (JOB-#### id, public_hash for careers / job-opening pages)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruit_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id VARCHAR(40) NOT NULL,
  public_hash VARCHAR(64) NOT NULL,
  title VARCHAR(190) NOT NULL,
  department VARCHAR(190) DEFAULT NULL,
  location VARCHAR(190) DEFAULT NULL,
  job_type VARCHAR(40) DEFAULT NULL,
  work_mode VARCHAR(40) DEFAULT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'open',
  positions INT NOT NULL DEFAULT 1,
  experience VARCHAR(120) DEFAULT NULL,
  salary_from DECIMAL(14,2) DEFAULT NULL,
  salary_to DECIMAL(14,2) DEFAULT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  start_date DATE DEFAULT NULL,
  end_date DATE DEFAULT NULL,
  recruiter VARCHAR(190) DEFAULT NULL,
  skills TEXT,
  description TEXT,
  requirements TEXT,
  show_on_careers TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_job_id (job_id),
  UNIQUE KEY uq_job_hash (public_hash),
  KEY idx_job_status (status),
  KEY idx_job_careers (show_on_careers)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. Job custom questions  (per-job application questions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruit_job_questions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id VARCHAR(40) NOT NULL,
  question VARCHAR(255) NOT NULL,
  type VARCHAR(40) NOT NULL DEFAULT 'text',
  options TEXT,
  required TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_jq_job (job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. Job Applications  (JAP-#### id, Kanban stage + custom question answers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruit_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id VARCHAR(40) NOT NULL,
  job_id VARCHAR(40) DEFAULT NULL,
  job_title VARCHAR(190) DEFAULT NULL,
  candidate_name VARCHAR(190) NOT NULL,
  email VARCHAR(190) DEFAULT NULL,
  phone VARCHAR(30) DEFAULT NULL,
  location VARCHAR(190) DEFAULT NULL,
  experience VARCHAR(120) DEFAULT NULL,
  current_company VARCHAR(190) DEFAULT NULL,
  expected_salary VARCHAR(60) DEFAULT NULL,
  resume_url VARCHAR(255) DEFAULT NULL,
  cover_letter TEXT,
  source VARCHAR(120) DEFAULT NULL,
  stage VARCHAR(40) NOT NULL DEFAULT 'applied',
  rating INT NOT NULL DEFAULT 0,
  answers TEXT,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jap_id (application_id),
  KEY idx_jap_job (job_id),
  KEY idx_jap_stage (stage),
  KEY idx_jap_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 5. Interview Schedule  (ISC-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruit_interviews (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  interview_id VARCHAR(40) NOT NULL,
  application_id VARCHAR(40) DEFAULT NULL,
  candidate_name VARCHAR(190) DEFAULT NULL,
  job_title VARCHAR(190) DEFAULT NULL,
  interviewer VARCHAR(190) DEFAULT NULL,
  scheduled_at DATETIME DEFAULT NULL,
  mode VARCHAR(40) DEFAULT NULL,
  location VARCHAR(255) DEFAULT NULL,
  round VARCHAR(120) DEFAULT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'scheduled',
  rating INT NOT NULL DEFAULT 0,
  feedback TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_isc_id (interview_id),
  KEY idx_isc_app (application_id),
  KEY idx_isc_status (status),
  KEY idx_isc_at (scheduled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 6. Job Offer Letter  (OFL-#### id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruit_offers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offer_id VARCHAR(40) NOT NULL,
  application_id VARCHAR(40) DEFAULT NULL,
  candidate_name VARCHAR(190) DEFAULT NULL,
  job_title VARCHAR(190) DEFAULT NULL,
  salary DECIMAL(14,2) DEFAULT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  joining_date DATE DEFAULT NULL,
  expiry_date DATE DEFAULT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'draft',
  content TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ofl_id (offer_id),
  KEY idx_ofl_app (application_id),
  KEY idx_ofl_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Sidebar wiring: ensure the Recruitment module + the new Worksuite feature
-- slugs exist. Idempotent via INSERT IGNORE on the unique slug keys.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO modules (name, slug, description, icon, sort_order)
SELECT 'Recruit', 'recruitment', 'Jobs, applications, interviews, offers and public careers.', 'user-plus', 4
FROM dual WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'recruitment');

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Recruit Dashboard', 'recruitment.view_dashboard', 'View the recruit dashboard', 1 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Jobs', 'recruitment.view_jobs', 'View and manage job postings', 2 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Job Applications', 'recruitment.view_applications', 'View and manage the application pipeline', 3 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Interview Schedule', 'recruitment.schedule_interviews', 'Schedule and track interviews', 4 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Job Offer Letter', 'recruitment.manage_offers', 'Create and manage offer letters', 5 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Job Skills', 'recruitment.view_skills', 'Manage the master list of job skills', 6 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Candidate Database', 'recruitment.view_candidates', 'Browse the candidate database', 7 FROM modules WHERE slug = 'recruitment';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Recruit Report', 'recruitment.view_reports', 'View recruitment reports', 8 FROM modules WHERE slug = 'recruitment';



-- FILE: 2026-09-11-add-knowledge-base.sql
-- Knowledge Base (matches Worksuite /account/knowledgebase)
-- Help articles grouped by category and addressed to employees or clients.
CREATE TABLE IF NOT EXISTS kb_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_category_name (name)
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  heading VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  category_id INT NULL,
  to_type ENUM('employees','clients') NOT NULL DEFAULT 'employees',
  created_by INT NULL,
  created_by_name VARCHAR(150) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_kb_articles_to_type (to_type),
  INDEX idx_kb_articles_category (category_id),
  CONSTRAINT fk_kb_article_category FOREIGN KEY (category_id) REFERENCES kb_categories (id) ON DELETE SET NULL
);

-- Feature: manage (create/edit/delete) articles and categories. The base
-- "knowledge-base.view" feature is already seeded by the workspace-modules migration.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Manage knowledge base', 'knowledge-base.manage', 'Create, edit and delete articles and categories', 93
FROM modules WHERE slug = 'knowledge-base';



-- FILE: 2026-09-11-upgrade-hr-attendance.sql
-- HR Attendance upgrade â€” additive columns for shift rules, status flags,
-- calendar linkage and admin override auditing. All columns are nullable or
-- defaulted so existing rows and the current clock-in/out flow keep working.
-- The application also creates these lazily (lib/hr-attendance.ts) so applying
-- this migration is recommended but not strictly required.
--
-- MySQL 8 has no ADD COLUMN IF NOT EXISTS; a "Duplicate column" error on a
-- column that already exists is safe to ignore. (MariaDB supports IF NOT EXISTS.)

-- Shift rule configuration used by the attendance calculation engine.
ALTER TABLE `hr_shifts` ADD COLUMN `grace_minutes` INT UNSIGNED NOT NULL DEFAULT 10;
ALTER TABLE `hr_shifts` ADD COLUMN `overtime_threshold_minutes` INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE `hr_shifts` ADD COLUMN `is_overnight` TINYINT(1) NOT NULL DEFAULT 0;
-- Comma-separated weekday numbers (0=Sun .. 6=Sat) that are weekly offs.
ALTER TABLE `hr_shifts` ADD COLUMN `weekly_offs` VARCHAR(30) DEFAULT NULL;

-- Attendance enrichment: exception flags, day type, calendar linkage, override audit.
ALTER TABLE `hr_attendance` ADD COLUMN `flags` VARCHAR(255) DEFAULT NULL;
ALTER TABLE `hr_attendance` ADD COLUMN `day_type` VARCHAR(30) DEFAULT NULL;
ALTER TABLE `hr_attendance` ADD COLUMN `leave_request_id` VARCHAR(50) DEFAULT NULL;
ALTER TABLE `hr_attendance` ADD COLUMN `is_manual_override` TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE `hr_attendance` ADD COLUMN `override_reason` VARCHAR(500) DEFAULT NULL;
ALTER TABLE `hr_attendance` ADD COLUMN `created_by` INT UNSIGNED DEFAULT NULL;
ALTER TABLE `hr_attendance` ADD COLUMN `updated_by` INT UNSIGNED DEFAULT NULL;

-- Speeds up employee + date-range queries (monthly view, employee 360, reports).
ALTER TABLE `hr_attendance` ADD INDEX `idx_hr_attendance_emp_date` (`employee_id`, `work_date`);



-- FILE: 2026-09-12-add-events.sql
CREATE TABLE IF NOT EXISTS `hr_events` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `label_color` VARCHAR(20) DEFAULT '#4f46e5',
  `location` VARCHAR(255) DEFAULT NULL,
  `description` TEXT DEFAULT NULL,
  `start_at` DATETIME NOT NULL,
  `end_at` DATETIME NOT NULL,
  `repeat_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `repeat_cycle` VARCHAR(20) DEFAULT 'week',
  `repeat_every` INT UNSIGNED DEFAULT 1,
  `repeat_ends_on` DATE DEFAULT NULL,
  `host_name` VARCHAR(150) DEFAULT NULL,
  `attendee_type` VARCHAR(20) NOT NULL DEFAULT 'all_employees',
  `attendees` TEXT DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_by_name` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_events_start` (`start_at`),
  KEY `idx_events_status` (`status`),
  CONSTRAINT `fk_events_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO modules (name, slug, description, icon, sort_order) SELECT 'Events', 'events', 'Company events, meetings, and gatherings.', 'ticket', 20 FROM dual WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'events');
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Events', 'events.view', 'View events', 1 FROM modules WHERE slug = 'events';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Manage Events', 'events.manage', 'Create, edit and delete events', 2 FROM modules WHERE slug = 'events';



-- FILE: 2026-09-12-harden-leave-quota-ledger.sql
-- Harden hr_leave_quota_history into a traceable, immutable transaction ledger.
--
-- These statements are applied idempotently at runtime by ensureLeaveSchema()
-- in lib/hr-leave.ts (columns are added only when missing, legacy rows are
-- backfilled, and the LQE sequence is seeded past the highest event id). This
-- file documents the resulting shape for reference and fresh installs.

-- Ensure the base ledger table exists before altering it, so this file can run
-- cleanly on a fresh install or a database that never applied the original
-- 2026-09-01-add-hr-leave-quota-history migration.
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
  INDEX idx_hr_quota_type_year (leave_type_id, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Stable, human-readable, server-generated event id (e.g. LQE-000123).
ALTER TABLE hr_leave_quota_history ADD COLUMN quota_event_id VARCHAR(40) DEFAULT NULL;
-- Source channel: System / Leave Request / Adjustment / Accrual / Carry Forward / Expiry / Import.
ALTER TABLE hr_leave_quota_history ADD COLUMN source VARCHAR(30) DEFAULT NULL;
-- Links a reversal row back to the quota_event_id of the event it reverses.
ALTER TABLE hr_leave_quota_history ADD COLUMN reversal_of VARCHAR(40) DEFAULT NULL;

-- Backfill legacy rows deterministically from the primary key (unique by design).
UPDATE hr_leave_quota_history
  SET quota_event_id = CONCAT('LQE-', LPAD(event_id, 6, '0'))
  WHERE quota_event_id IS NULL OR quota_event_id = '';

UPDATE hr_leave_quota_history SET source = CASE event_type
    WHEN 'accrual' THEN 'Accrual'
    WHEN 'carry_forward' THEN 'Carry Forward'
    WHEN 'expiry' THEN 'Expiry'
    WHEN 'leave_approved' THEN 'Leave Request'
    WHEN 'leave_reversed' THEN 'Leave Request'
    WHEN 'adjustment' THEN 'Adjustment'
    WHEN 'reversal' THEN 'Adjustment'
    ELSE 'System' END
  WHERE source IS NULL OR source = '';

-- Seed the shared record-id sequence past the highest existing event id so
-- generated LQE ids can never collide with the backfilled ones.
INSERT INTO record_id_sequences (prefix, next_number)
  SELECT 'LQE', COALESCE(MAX(event_id), 0) FROM hr_leave_quota_history
  ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));

-- Uniqueness + lookup indexes.
ALTER TABLE hr_leave_quota_history ADD UNIQUE KEY uq_quota_event_id (quota_event_id);
ALTER TABLE hr_leave_quota_history ADD INDEX idx_quota_reference (reference);
ALTER TABLE hr_leave_quota_history ADD INDEX idx_quota_reversal_of (reversal_of);



-- FILE: 2026-09-12-hr-email-hub.sql
-- =====================================================================
-- HR Email Hub â€” Phase 1 foundation
-- ---------------------------------------------------------------------
-- Extends the existing hr_emails table into a central communication hub:
-- stable Email IDs (HRE-YYYY-NNNNNN), categories, source-module linkage,
-- CC/BCC, manual vs. automated origin, scheduling + queue bookkeeping,
-- attachments and idempotent dedupe keys.
--
-- These ALTERs use `IF NOT EXISTS` (MariaDB / MySQL 8.0.29+). The same
-- changes are also applied idempotently at runtime by
-- ensureHrEmailHubSchema() in lib/hr-email.ts, so the feature keeps working
-- even if this migration has not been run manually in phpMyAdmin.
-- =====================================================================

ALTER TABLE hr_emails
  ADD COLUMN IF NOT EXISTS email_uid       VARCHAR(40)  NULL AFTER id,
  ADD COLUMN IF NOT EXISTS category        VARCHAR(60)  NOT NULL DEFAULT 'General',
  ADD COLUMN IF NOT EXISTS source_module   VARCHAR(40)  NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_record_id VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS cc              TEXT         NULL,
  ADD COLUMN IF NOT EXISTS bcc             TEXT         NULL,
  ADD COLUMN IF NOT EXISTS email_type      ENUM('Manual','Automated') NOT NULL DEFAULT 'Manual',
  ADD COLUMN IF NOT EXISTS scheduled_at    DATETIME     NULL,
  ADD COLUMN IF NOT EXISTS attempts        INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error      VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS dedupe_key      VARCHAR(190) NULL,
  ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS attachment_size INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Expand the status lifecycle beyond Sent/Failed/Draft.
ALTER TABLE hr_emails
  MODIFY COLUMN status ENUM('Draft','Scheduled','Queued','Sending','Sent','Failed','Cancelled')
  NOT NULL DEFAULT 'Sent';

-- Unique Email ID, dedupe guard (MySQL allows many NULLs in a UNIQUE index),
-- and a dispatcher-friendly index over the scheduling queue.
ALTER TABLE hr_emails
  ADD UNIQUE KEY IF NOT EXISTS uq_hr_emails_uid (email_uid),
  ADD UNIQUE KEY IF NOT EXISTS uq_hr_emails_dedupe (dedupe_key),
  ADD KEY IF NOT EXISTS idx_hr_emails_status (status),
  ADD KEY IF NOT EXISTS idx_hr_emails_category (category),
  ADD KEY IF NOT EXISTS idx_hr_emails_queue (status, scheduled_at),
  ADD KEY IF NOT EXISTS idx_hr_emails_source (source_module, source_record_id);

-- Backfill an origin for any legacy rows that predate these columns.
UPDATE hr_emails SET source_module = 'manual' WHERE source_module IS NULL OR source_module = '';
UPDATE hr_emails SET category = 'General' WHERE category IS NULL OR category = '';

-- ---------------------------------------------------------------------
-- Granular HR email permissions (legacy feature rows). Under the matrix
-- model these resolve onto the hr.emails module (send/schedule/bulk =>
-- update, view tracking => view); the rows also drive the legacy grant path.
-- ---------------------------------------------------------------------
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Send HR Email','hr.send_email','Compose and send HR emails',32 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Send Bulk HR Email','hr.send_bulk_email','Send HR emails to multiple recipients',33 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Schedule HR Email','hr.schedule_email','Queue HR emails to send later',34 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'View Email Tracking','hr.view_email_tracking','See opens and delivery status',35 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Send Sensitive HR Email','hr.send_sensitive_email','Send confidential/warning category emails',36 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'Manage Email Automation','hr.manage_email_automation','Configure automated HR email rules',37 FROM modules WHERE slug='hr';



-- FILE: 2026-09-12-hr-master-data-productionize.sql
-- HR Master Data productionization.
--
-- These statements are also applied idempotently at runtime by
-- ensureHrMasterSchema() in lib/hr-master-data.ts, so they are safe to run (or
-- re-run) against an existing production database. IDs of existing rows are
-- preserved; display codes are backfilled deterministically from the PK.

-- Shared audit trail for every HR master change (single table, not per-module).
CREATE TABLE IF NOT EXISTS hr_master_audit (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  module VARCHAR(40) NOT NULL,
  record_id VARCHAR(80) NOT NULL,
  action VARCHAR(40) NOT NULL,
  user_id INT NULL,
  user_name VARCHAR(150) NULL,
  old_value JSON NULL,
  new_value JSON NULL,
  source VARCHAR(40) NOT NULL DEFAULT 'master-data',
  remarks VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_hma_module (module),
  KEY idx_hma_record (module, record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Display-code columns for numeric-PK masters (kept alongside the numeric PK).
ALTER TABLE hr_promotions   ADD COLUMN promotion_code    VARCHAR(40) NULL;
ALTER TABLE hr_awards       ADD COLUMN award_code        VARCHAR(40) NULL;
ALTER TABLE hr_appreciations ADD COLUMN appreciation_code VARCHAR(40) NULL;
ALTER TABLE hr_holidays     ADD COLUMN holiday_code      VARCHAR(40) NULL;
ALTER TABLE hr_passport_visa ADD COLUMN pv_code          VARCHAR(40) NULL;

-- Promotion approval / effective-date audit columns.
ALTER TABLE hr_promotions ADD COLUMN approved_at TIMESTAMP NULL;
ALTER TABLE hr_promotions ADD COLUMN effected_at TIMESTAMP NULL;

-- Deterministic backfill of display codes for historical rows.
UPDATE hr_promotions    SET promotion_code    = CONCAT('PROM-', YEAR(created_at), '-', LPAD(promotion_id,6,'0'))          WHERE promotion_code IS NULL OR promotion_code = '';
UPDATE hr_awards        SET award_code        = CONCAT('AWD-',  YEAR(created_at), '-', LPAD(award_id,6,'0'))              WHERE award_code IS NULL OR award_code = '';
UPDATE hr_appreciations SET appreciation_code = CONCAT('APP-',  YEAR(created_at), '-', LPAD(appreciation_id,6,'0'))       WHERE appreciation_code IS NULL OR appreciation_code = '';
UPDATE hr_holidays      SET holiday_code      = CONCAT('HOL-',  COALESCE(year, YEAR(created_at)), '-', LPAD(holiday_id,6,'0')) WHERE holiday_code IS NULL OR holiday_code = '';
UPDATE hr_passport_visa SET pv_code          = CONCAT('PVR-',  LPAD(record_id,4,'0'))                                    WHERE pv_code IS NULL OR pv_code = '';

CREATE UNIQUE INDEX uniq_promotion_code    ON hr_promotions (promotion_code);
CREATE UNIQUE INDEX uniq_award_code        ON hr_awards (award_code);
CREATE UNIQUE INDEX uniq_appreciation_code ON hr_appreciations (appreciation_code);
CREATE UNIQUE INDEX uniq_holiday_code      ON hr_holidays (holiday_code);
CREATE UNIQUE INDEX uniq_pv_code           ON hr_passport_visa (pv_code);

-- Query-pattern indexes (spec Â§62).
CREATE INDEX idx_dept_status ON hr_departments (status);
CREATE INDEX idx_dept_parent ON hr_departments (parent_department_id);
CREATE INDEX idx_desg_status ON hr_designations (status);
CREATE INDEX idx_desg_parent ON hr_designations (parent_designation_id);
CREATE INDEX idx_prom_emp    ON hr_promotions (employee_id);
CREATE INDEX idx_prom_eff    ON hr_promotions (effective_date);
CREATE INDEX idx_prom_status ON hr_promotions (status);
CREATE INDEX idx_awd_emp     ON hr_awards (employee_id);
CREATE INDEX idx_app_emp     ON hr_appreciations (employee_id);
CREATE INDEX idx_pv_emp      ON hr_passport_visa (employee_id);
CREATE INDEX idx_pv_pexp     ON hr_passport_visa (passport_expiry_date);
CREATE INDEX idx_pv_vexp     ON hr_passport_visa (visa_expiry_date);
CREATE INDEX idx_hol_date    ON hr_holidays (holiday_date);
CREATE INDEX idx_hol_dept    ON hr_holidays (applicable_department_id);
CREATE INDEX idx_hol_status  ON hr_holidays (status);



-- FILE: 2026-09-12-upgrade-hr-shift-assignments.sql
-- ---------------------------------------------------------------------------
-- Upgrade & productionize HR â†’ Shifts â†’ Shift Assignments.
--
-- Additive and idempotent. Every statement is safe to re-run and preserves
-- existing hr_shift_assignments rows and their historical assignment_id values.
-- The application also applies these lazily via ensureShiftAssignmentSchema()
-- so a database that never runs this file still gets the columns/tables.
--
-- Idempotency note: plain `ALTER TABLE ... ADD COLUMN` / `CREATE INDEX` throw
-- (#1060 duplicate column, #1061 duplicate key) when the object already exists,
-- and `ADD COLUMN IF NOT EXISTS` is not portable across MySQL versions. So we
-- guard every additive change with a stored procedure that first checks
-- information_schema and only runs the DDL when the object is missing.
--
-- Shift Assignments is the authoritative employee->shift relationship. It never
-- stores employee, shift-policy, rotation or attendance data â€” those live in
-- their own masters and are only referenced here.
-- ---------------------------------------------------------------------------

-- --- Guarded DDL helpers ----------------------------------------------------

DROP PROCEDURE IF EXISTS __v0_add_column;
DROP PROCEDURE IF EXISTS __v0_add_index;

DELIMITER //

-- Add a column only when it does not already exist on the given table.
CREATE PROCEDURE __v0_add_column(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = p_table
       AND COLUMN_NAME = p_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //

-- Add an index only when an index of that name does not already exist.
CREATE PROCEDURE __v0_add_index(
  IN p_table VARCHAR(64),
  IN p_index VARCHAR(64),
  IN p_columns TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = p_table
       AND INDEX_NAME = p_index
  ) THEN
    SET @ddl = CONCAT('CREATE INDEX `', p_index, '` ON `', p_table, '` ', p_columns);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //

DELIMITER ;

-- --- Source tracking & lifecycle columns (Â§13, Â§60) -------------------------
-- change_type / source_request_id may already exist from the shift-change
-- migration; each call is a no-op if the column is present.
CALL __v0_add_column('hr_shift_assignments', 'source_type',        "VARCHAR(40) NOT NULL DEFAULT 'MANUAL'");
CALL __v0_add_column('hr_shift_assignments', 'source_id',          "VARCHAR(50) DEFAULT NULL");
CALL __v0_add_column('hr_shift_assignments', 'change_type',        "ENUM('Temporary','Permanent') NOT NULL DEFAULT 'Permanent'");
CALL __v0_add_column('hr_shift_assignments', 'source_request_id',  "VARCHAR(50) DEFAULT NULL");
CALL __v0_add_column('hr_shift_assignments', 'assigned_by_name',   "VARCHAR(150) DEFAULT NULL");
CALL __v0_add_column('hr_shift_assignments', 'ended_by',           "BIGINT UNSIGNED DEFAULT NULL");
CALL __v0_add_column('hr_shift_assignments', 'ended_at',           "DATETIME DEFAULT NULL");
CALL __v0_add_column('hr_shift_assignments', 'created_at',         "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
CALL __v0_add_column('hr_shift_assignments', 'updated_at',         "TIMESTAMP NULL DEFAULT NULL");

-- Backfill provenance for rows created before source tracking existed: anything
-- linked to a shift change request is SHIFT_CHANGE_REQUEST, everything else MANUAL.
UPDATE hr_shift_assignments
   SET source_type = 'SHIFT_CHANGE_REQUEST', source_id = source_request_id
 WHERE source_request_id IS NOT NULL AND (source_type IS NULL OR source_type = 'MANUAL');

-- --- Indexes for the hot resolver path and shift reports ---------------------
CALL __v0_add_index('hr_shift_assignments', 'idx_shift_assignment_emp_dates',   '(employee_id, effective_from, effective_to)');
CALL __v0_add_index('hr_shift_assignments', 'idx_shift_assignment_shift_dates', '(shift_id, effective_from, effective_to)');
CALL __v0_add_index('hr_shift_assignments', 'idx_shift_assignment_status',      '(status, effective_from)');

-- Helpers are one-shot; drop them so the schema stays clean.
DROP PROCEDURE IF EXISTS __v0_add_column;
DROP PROCEDURE IF EXISTS __v0_add_index;

-- --- Per-assignment audit trail (Â§35) ---------------------------------------
-- Mirrors hr_shift_events / hr_employee_events. CREATE TABLE IF NOT EXISTS is
-- natively idempotent.
CREATE TABLE IF NOT EXISTS hr_shift_assignment_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  assignment_id VARCHAR(50) NOT NULL,
  employee_id BIGINT UNSIGNED DEFAULT NULL,
  event_type VARCHAR(60) NOT NULL,
  summary VARCHAR(255) NOT NULL,
  changes JSON DEFAULT NULL,
  reason VARCHAR(500) DEFAULT NULL,
  actor_id BIGINT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(150) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_shift_assignment_event_ref (assignment_id, created_at),
  KEY idx_shift_assignment_event_emp (employee_id),
  KEY idx_shift_assignment_event_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- RBAC features for the module -------------------------------------------
-- Best-effort; INSERT IGNORE is idempotent and no-ops if modules/features differ.
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Manage Shift Assignments','hr.manage_shift_assignments','Create, edit and end shift assignments',21 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Override Shift Assignment Conflicts','hr.override_shift_assignments','Override overlapping/rotation assignment conflicts',22 FROM modules WHERE slug='hr';



-- FILE: 2026-09-12-upgrade-hr-support-helpdesk.sql
-- ---------------------------------------------------------------------------
-- HR Support â†’ full internal HR Helpdesk / Case Management.
--
-- This migration brings the persisted schema in line with the runtime
-- self-heal in lib/hr-support.ts (ensureSupportSchema). It is additive and
-- idempotent: every new column is nullable/defaulted so historical tickets and
-- the original clock-in/POST paths keep working unchanged. Running it is
-- optional â€” the app self-heals the same schema on first request â€” but keeping
-- it here gives DBAs a reviewable source of truth.
--
-- NOTE: MySQL 8 has no `ADD COLUMN IF NOT EXISTS`. If a column already exists
-- (e.g. because the runtime self-heal ran first) the individual ALTER will
-- error with "Duplicate column name"; that is safe to ignore.
-- ---------------------------------------------------------------------------

-- Ticket record: employee/context snapshot, subcategory, source, SLA tracking,
-- CSAT, reopen count and cross-module related-record foreign keys.
ALTER TABLE hr_support_tickets ADD COLUMN created_by_user_id BIGINT UNSIGNED NULL;
ALTER TABLE hr_support_tickets ADD COLUMN created_by_name VARCHAR(150) NULL;
ALTER TABLE hr_support_tickets ADD COLUMN department VARCHAR(150) NULL;
ALTER TABLE hr_support_tickets ADD COLUMN designation VARCHAR(150) NULL;
ALTER TABLE hr_support_tickets ADD COLUMN manager_name VARCHAR(150) NULL;
ALTER TABLE hr_support_tickets ADD COLUMN subcategory VARCHAR(120) NULL;
ALTER TABLE hr_support_tickets ADD COLUMN issue_type VARCHAR(120) NULL;
ALTER TABLE hr_support_tickets ADD COLUMN source VARCHAR(30) NOT NULL DEFAULT 'Web';
ALTER TABLE hr_support_tickets ADD COLUMN is_sensitive TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE hr_support_tickets ADD COLUMN first_response_due DATETIME NULL;
ALTER TABLE hr_support_tickets ADD COLUMN sla_response_breached TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE hr_support_tickets ADD COLUMN sla_resolution_breached TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE hr_support_tickets ADD COLUMN reopened_count INT NOT NULL DEFAULT 0;
ALTER TABLE hr_support_tickets ADD COLUMN csat_rating TINYINT NULL;
ALTER TABLE hr_support_tickets ADD COLUMN csat_comment TEXT NULL;
ALTER TABLE hr_support_tickets ADD COLUMN related_attendance_id BIGINT UNSIGNED NULL;
ALTER TABLE hr_support_tickets ADD COLUMN related_regularisation_id BIGINT UNSIGNED NULL;
ALTER TABLE hr_support_tickets ADD COLUMN related_leave_id BIGINT UNSIGNED NULL;
ALTER TABLE hr_support_tickets ADD COLUMN related_document_id BIGINT UNSIGNED NULL;
ALTER TABLE hr_support_tickets ADD COLUMN related_payroll_id BIGINT UNSIGNED NULL;
ALTER TABLE hr_support_tickets ADD COLUMN related_offboarding_id BIGINT UNSIGNED NULL;
ALTER TABLE hr_support_tickets ADD COLUMN updated_at DATETIME NULL;

-- Conversation thread: employee replies, HR replies and private internal notes.
CREATE TABLE IF NOT EXISTS hr_support_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  author_user_id BIGINT UNSIGNED NULL,
  author_name VARCHAR(150) NULL,
  author_role VARCHAR(20) NULL,
  body TEXT NOT NULL,
  is_internal TINYINT(1) NOT NULL DEFAULT 0,
  attachment_path VARCHAR(500) NULL,
  attachment_name VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_support_msg_ticket (ticket_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Secure attachment registry (file lives in blob storage; row records metadata).
CREATE TABLE IF NOT EXISTS hr_support_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NULL,
  file_name VARCHAR(255) NULL,
  file_url VARCHAR(500) NOT NULL,
  file_size BIGINT UNSIGNED NULL,
  uploaded_by BIGINT UNSIGNED NULL,
  uploaded_by_name VARCHAR(150) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_support_att_ticket (ticket_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Activity timeline / audit trail (created, assigned, status, SLA, reopenâ€¦).
CREATE TABLE IF NOT EXISTS hr_support_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  actor_name VARCHAR(150) NULL,
  event_type VARCHAR(60) NOT NULL,
  detail VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_support_event_ticket (ticket_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Configurable category master (default priority + business-hour SLA windows).
CREATE TABLE IF NOT EXISTS hr_support_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(120) NOT NULL UNIQUE,
  default_priority ENUM('Low','Medium','High','Urgent') NOT NULL DEFAULT 'Medium',
  response_sla_hours INT NOT NULL DEFAULT 8,
  resolution_sla_hours INT NOT NULL DEFAULT 40,
  is_sensitive TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Optional lightweight knowledge base (future-ready; suggested to agents).
CREATE TABLE IF NOT EXISTS hr_support_kb (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  slug VARCHAR(200) NOT NULL UNIQUE,
  category_slug VARCHAR(120) NULL,
  body TEXT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the default HR support categories (idempotent on slug).
INSERT IGNORE INTO hr_support_categories
  (name, slug, default_priority, response_sla_hours, resolution_sla_hours, is_sensitive, sort_order, active)
VALUES
  ('Payroll', 'payroll', 'High', 4, 24, 0, 1, 1),
  ('Attendance', 'attendance', 'Medium', 4, 16, 0, 2, 1),
  ('Attendance Regularisation', 'regularisation', 'Medium', 4, 16, 0, 3, 1),
  ('Leave', 'leave', 'Medium', 4, 16, 0, 4, 1),
  ('Reimbursement', 'reimbursement', 'Medium', 8, 40, 0, 5, 1),
  ('Documents', 'documents', 'Low', 8, 40, 0, 6, 1),
  ('IT / Systems', 'it-systems', 'High', 2, 8, 0, 7, 1),
  ('Facilities', 'facilities', 'Low', 8, 40, 0, 8, 1),
  ('Onboarding', 'onboarding', 'Medium', 8, 24, 0, 9, 1),
  ('Offboarding', 'offboarding', 'Medium', 8, 24, 0, 10, 1),
  ('Policy', 'policy', 'Low', 8, 40, 0, 11, 1),
  ('Grievance', 'grievance', 'High', 4, 24, 1, 12, 1),
  ('Other', 'other', 'Medium', 8, 40, 0, 99, 1);

-- RBAC: gate for viewing sensitive (grievance) tickets. view/manage features
-- are already seeded by 2026-09-01-add-hr-support.sql.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View Sensitive HR Tickets', 'hr.view_sensitive_support',
       'Access grievances and other sensitive HR support cases', 7
FROM modules WHERE slug = 'hr';



-- FILE: 2026-09-13-add-finance-payments.sql
-- ---------------------------------------------------------------------------
-- Phase 2 â€” Payments as source of truth + cancel reversal
--
-- Run-once, idempotent. Adds the `payments` table (append-only cash receipts
-- applied against a source document, currently sales invoices), the columns a
-- sales invoice needs to track a cancel reversal, and the PAY id sequence.
--
-- A payment records money actually received. Recording it posts the cash side
-- of the entry (Dr Bank/Cash, Cr Accounts Receivable) so the ledger â€” not a
-- free-text field on the invoice â€” becomes the source of truth for cash.
-- Reversing a payment (bounced cheque, mistaken entry) unwinds that voucher;
-- cancelling a posted invoice reverses its original sales voucher.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  payment_id VARCHAR(40) NOT NULL,
  -- source document this receipt is applied against
  entity_type VARCHAR(40) NOT NULL DEFAULT 'sales_invoice',
  invoice_pk BIGINT UNSIGNED DEFAULT NULL,
  invoice_ref VARCHAR(40) DEFAULT NULL,
  party_id VARCHAR(40) DEFAULT NULL,
  party_name VARCHAR(255) DEFAULT NULL,
  payment_date DATE NOT NULL,
  financial_year VARCHAR(12) DEFAULT NULL,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  -- how the money arrived; deposit_role selects the ledger account (bank|cash)
  payment_mode VARCHAR(20) NOT NULL DEFAULT 'Bank',
  deposit_role VARCHAR(10) NOT NULL DEFAULT 'bank',
  reference_no VARCHAR(120) DEFAULT NULL,
  narration VARCHAR(255) DEFAULT NULL,
  -- cash-side posting created when the payment is recorded
  voucher_no VARCHAR(40) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',        -- Active | Reversed
  reversal_voucher_no VARCHAR(40) DEFAULT NULL,
  reversal_reason VARCHAR(255) DEFAULT NULL,
  reversed_at TIMESTAMP NULL DEFAULT NULL,
  reversed_by BIGINT UNSIGNED DEFAULT NULL,
  idempotency_key VARCHAR(80) DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pay_payment_id (payment_id),
  UNIQUE KEY uq_pay_idempotency (idempotency_key),
  KEY idx_pay_invoice (invoice_pk),
  KEY idx_pay_status (status),
  KEY idx_pay_party (party_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Reversal tracking for a cancelled posted invoice. cancelled_at already exists
-- (added by the sales-invoice runtime schema); only the voucher/reason are new.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'sales_invoices' AND column_name = 'reversal_voucher_no');
SET @sql := IF(@col = 0,
  'ALTER TABLE sales_invoices ADD COLUMN reversal_voucher_no VARCHAR(40) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'sales_invoices' AND column_name = 'cancel_reason');
SET @sql := IF(@col = 0,
  'ALTER TABLE sales_invoices ADD COLUMN cancel_reason VARCHAR(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- PAY id sequence (nextRecordId("PAY")). Seed only if not already present.
INSERT INTO record_id_sequences (prefix, next_number)
SELECT 'PAY', 0
WHERE NOT EXISTS (SELECT 1 FROM record_id_sequences WHERE prefix = 'PAY');



-- FILE: 2026-09-13-add-finance-posting-audit.sql
-- Finance posting + audit backbone.
--
-- Phase 1 of the Sales Invoice â†’ General Ledger integration. This migration is
-- schema-only (no application data is touched) and is safe to run once against
-- the live database. It adds:
--
--   1. A voucher-grouping column on journal_entries + general_ledger so the
--      several debit/credit lines that make up one balanced posting can be tied
--      together (journal_entry_id stays unique per line; voucher_no groups them).
--   2. finance_audit_events â€” an append-only, tamper-evident trail of every
--      lifecycle action on a financial document (created / issued / posted /
--      payment recorded / cancelled / reversed).
--   3. A default Chart of Accounts (only inserted where the account_code is not
--      already present) so the posting engine has real accounts to target.
--
-- Column type conventions mirror the earlier finance migrations:
--   ids .......... VARCHAR(40)      names ........ VARCHAR(190)
--   money ........ DECIMAL(14,2)    selects ...... VARCHAR(20-80)
--
-- The ALTER/ADD steps are guarded with information_schema checks so the file is
-- idempotent and can be re-applied without error.

-- ---------------------------------------------------------------------------
-- 1. Voucher grouping columns (idempotent add).
-- ---------------------------------------------------------------------------
SET @has_je_voucher := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'journal_entries'
     AND column_name = 'voucher_no'
);
SET @sql := IF(@has_je_voucher = 0,
  'ALTER TABLE journal_entries
     ADD COLUMN voucher_no VARCHAR(40) DEFAULT NULL AFTER journal_entry_id,
     ADD KEY idx_je_voucher (voucher_no)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_gl_voucher := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'general_ledger'
     AND column_name = 'voucher_no'
);
SET @sql := IF(@has_gl_voucher = 0,
  'ALTER TABLE general_ledger
     ADD COLUMN voucher_no VARCHAR(40) DEFAULT NULL AFTER journal_entry_id,
     ADD KEY idx_gl_voucher (voucher_no)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Link a general_ledger row back to the source document (entity + id). These
-- complement the existing source_module / source_reference free-text columns
-- with a stable, queryable pair used by the posting engine and drill-downs.
SET @has_gl_srctype := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'general_ledger'
     AND column_name = 'source_entity_type'
);
SET @sql := IF(@has_gl_srctype = 0,
  'ALTER TABLE general_ledger
     ADD COLUMN source_entity_type VARCHAR(40) DEFAULT NULL AFTER source_reference,
     ADD COLUMN source_entity_id BIGINT UNSIGNED DEFAULT NULL AFTER source_entity_type,
     ADD KEY idx_gl_source_entity (source_entity_type, source_entity_id)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_je_srctype := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'journal_entries'
     AND column_name = 'source_entity_type'
);
SET @sql := IF(@has_je_srctype = 0,
  'ALTER TABLE journal_entries
     ADD COLUMN source_entity_type VARCHAR(40) DEFAULT NULL AFTER source_reference,
     ADD COLUMN source_entity_id BIGINT UNSIGNED DEFAULT NULL AFTER source_entity_type,
     ADD KEY idx_je_source_entity (source_entity_type, source_entity_id)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2. Finance audit events â€” append-only lifecycle trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity_type VARCHAR(40) NOT NULL,
  entity_pk BIGINT UNSIGNED DEFAULT NULL,
  entity_ref VARCHAR(60) DEFAULT NULL,
  event_type VARCHAR(60) NOT NULL,
  summary VARCHAR(255) NOT NULL,
  detail JSON DEFAULT NULL,
  amount DECIMAL(14,2) DEFAULT NULL,
  voucher_no VARCHAR(40) DEFAULT NULL,
  actor_id BIGINT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(190) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fae_entity (entity_type, entity_pk, created_at),
  KEY idx_fae_ref (entity_ref),
  KEY idx_fae_event (event_type),
  KEY idx_fae_voucher (voucher_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. Default Chart of Accounts (only where the code is not already present).
--    Codes here are the posting engine's built-in defaults; a company can add
--    its own accounts with the same codes and the engine will prefer those.
-- ---------------------------------------------------------------------------
INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-AR', '1200', 'Accounts Receivable',
  'Asset', 'Current Asset', 'Debit',
  0, 0, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1200');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-TDS-RECV', '1450', 'TDS Receivable', 'Asset', 'Current Asset', 'Debit',
  0, 0, 1, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1450');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-BANK', '1000', 'Bank Account', 'Asset', 'Bank', 'Debit',
  1, 0, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1000');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-CASH', '1010', 'Cash', 'Asset', 'Cash', 'Debit',
  1, 0, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1010');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-SALES', '4000', 'Sales Revenue', 'Income', 'Direct Income', 'Credit',
  0, 1, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '4000');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-CGST-OUT', '2110', 'Output CGST Payable', 'Liability', 'Duties & Taxes', 'Credit',
  0, 1, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2110');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-SGST-OUT', '2120', 'Output SGST Payable', 'Liability', 'Duties & Taxes', 'Credit',
  0, 1, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2120');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-IGST-OUT', '2130', 'Output IGST Payable', 'Liability', 'Duties & Taxes', 'Credit',
  0, 1, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2130');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT
  'COA-CESS-OUT', '2140', 'Output Cess Payable', 'Liability', 'Duties & Taxes', 'Credit',
  0, 1, 0, 'Active'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2140');

-- ---------------------------------------------------------------------------
-- 4. Record-id sequence for balanced-posting voucher numbers (VCH-####).
-- ---------------------------------------------------------------------------
INSERT INTO record_id_sequences (prefix, next_number) VALUES ('VCH', 0)
ON DUPLICATE KEY UPDATE prefix = VALUES(prefix);



-- FILE: 2026-09-13-add-tickets.sql
-- Worksuite-style Tickets (helpdesk) feature.
-- Employees with `tickets.view` can raise tickets and see ONLY their own.
-- Management with `tickets.manage` can see ALL tickets, update status, assign agents, reply and delete.

CREATE TABLE IF NOT EXISTS `hr_tickets` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `subject` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `type` VARCHAR(50) NOT NULL DEFAULT 'general',
  `priority` VARCHAR(20) NOT NULL DEFAULT 'medium',
  `status` VARCHAR(20) NOT NULL DEFAULT 'open',
  `requester_name` VARCHAR(150) DEFAULT NULL,
  `requester_email` VARCHAR(190) DEFAULT NULL,
  `agent_name` VARCHAR(150) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_by_name` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tickets_status` (`status`),
  KEY `idx_tickets_priority` (`priority`),
  KEY `idx_tickets_created_by` (`created_by`),
  CONSTRAINT `fk_tickets_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `hr_ticket_replies` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ticket_id` INT UNSIGNED NOT NULL,
  `message` TEXT NOT NULL,
  `author_id` INT UNSIGNED DEFAULT NULL,
  `author_name` VARCHAR(150) DEFAULT NULL,
  `is_staff` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ticket_replies_ticket` (`ticket_id`),
  CONSTRAINT `fk_ticket_replies_ticket` FOREIGN KEY (`ticket_id`) REFERENCES `hr_tickets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ensure the Tickets module exists (it may already be registered as a placeholder).
INSERT INTO modules (name, slug, description, icon, sort_order)
SELECT 'Tickets', 'tickets', 'Support requests and helpdesk tickets.', 'ticket-check', 31
FROM dual
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'tickets');

-- Remove the old placeholder features (and any granted permissions) so the permission list stays clean.
DELETE up FROM user_permissions up
  JOIN features f ON f.id = up.feature_id
  JOIN modules m ON m.id = f.module_id
  WHERE m.slug = 'tickets' AND f.slug IN ('tickets.view_dashboard', 'tickets.view_tickets');
DELETE f FROM features f
  JOIN modules m ON m.id = f.module_id
  WHERE m.slug = 'tickets' AND f.slug IN ('tickets.view_dashboard', 'tickets.view_tickets');

-- New permission model.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Raise & View Own Tickets', 'tickets.view', 'Raise tickets and view only your own tickets', 1 FROM modules WHERE slug = 'tickets';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Manage All Tickets', 'tickets.manage', 'View all employees'' tickets, update status, assign agents, reply and delete', 2 FROM modules WHERE slug = 'tickets';



-- FILE: 2026-09-13-finance-email-templates.sql
-- Finance Email Template Management
-- Extends the minimal finance_email_templates table into a full, governed
-- template library mirroring HR: stable Template ID (FNET-0001), machine key,
-- description, category, audience, plain-text alternative, lifecycle status,
-- versioning, and usage analytics. Backward compatible with the existing
-- finance email composer, which reads subject/body where status = 'Active'.

CREATE TABLE IF NOT EXISTS finance_email_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body LONGTEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE finance_email_templates
  ADD COLUMN IF NOT EXISTS template_uid VARCHAR(40) NULL,
  ADD COLUMN IF NOT EXISTS template_key VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS description VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS category VARCHAR(60) NOT NULL DEFAULT 'General',
  ADD COLUMN IF NOT EXISTS audience VARCHAR(40) NOT NULL DEFAULT 'Customer',
  ADD COLUMN IF NOT EXISTS body_text LONGTEXT NULL,
  ADD COLUMN IF NOT EXISTS version INT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS usage_count INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS attachment_size INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS created_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS updated_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Full lifecycle. Existing 'Active'/'Inactive' rows stay valid.
ALTER TABLE finance_email_templates
  MODIFY COLUMN status ENUM('Draft','Active','Inactive','Archived') NOT NULL DEFAULT 'Draft';

-- MySQL has no `CREATE INDEX IF NOT EXISTS`, so guard each index against
-- information_schema to keep this migration safely re-runnable.
SET @exist := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'finance_email_templates'
  AND index_name = 'uq_finance_email_templates_uid');
SET @sql := IF(@exist = 0,
  'CREATE UNIQUE INDEX uq_finance_email_templates_uid ON finance_email_templates (template_uid)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'finance_email_templates'
  AND index_name = 'uq_finance_email_templates_key');
SET @sql := IF(@exist = 0,
  'CREATE UNIQUE INDEX uq_finance_email_templates_key ON finance_email_templates (template_key)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'finance_email_templates'
  AND index_name = 'idx_finance_email_templates_status');
SET @sql := IF(@exist = 0,
  'CREATE INDEX idx_finance_email_templates_status ON finance_email_templates (status)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'finance_email_templates'
  AND index_name = 'idx_finance_email_templates_category');
SET @sql := IF(@exist = 0,
  'CREATE INDEX idx_finance_email_templates_category ON finance_email_templates (category)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Immutable snapshot of every saved revision for audit / rollback.
CREATE TABLE IF NOT EXISTS finance_email_template_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body LONGTEXT NOT NULL,
  body_text LONGTEXT NULL,
  category VARCHAR(60) NULL,
  audience VARCHAR(40) NULL,
  status VARCHAR(20) NULL,
  changed_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_finance_email_template_versions_tpl (template_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-13-hr-email-automation.sql
-- =====================================================================
-- HR Email Hub â€” Phase 2: event-driven automation config
-- ---------------------------------------------------------------------
-- Stores per-event automation rules for the HR communication engine:
-- which HR workflow events send an automated email, which template they
-- use (NULL = built-in default in lib/hr-email-automation.ts), and whether
-- the reporting manager is auto-CC'd.
--
-- This table is also created + seeded idempotently at runtime by
-- ensureHrEmailAutomationSchema() in lib/hr-email-automation.ts, so the
-- feature keeps working even if this migration has not been run manually.
-- =====================================================================

CREATE TABLE IF NOT EXISTS hr_email_automations (
  event_key   VARCHAR(60)     NOT NULL PRIMARY KEY,
  enabled     TINYINT(1)      NOT NULL DEFAULT 1,
  template_id BIGINT UNSIGNED NULL,
  cc_manager  TINYINT(1)      NOT NULL DEFAULT 0,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the known event catalog (matches HR_EMAIL_EVENTS). cc_manager mirrors
-- each event's ccManagerDefault; INSERT IGNORE keeps existing overrides intact.
INSERT IGNORE INTO hr_email_automations (event_key, enabled, cc_manager) VALUES
  ('leave_submitted',        1, 1),
  ('leave_approved',         1, 1),
  ('leave_rejected',         1, 1),
  ('leave_cancelled',        1, 0),
  ('shift_change_submitted', 1, 1),
  ('shift_change_approved',  1, 1),
  ('shift_change_rejected',  1, 0),
  ('promotion_effective',    1, 1),
  ('support_ticket_created', 1, 0),
  ('offboarding_initiated',  1, 0),
  ('offboarding_completed',  1, 0);



-- FILE: 2026-09-13-hr-email-templates.sql
-- HR Email Template Management (Phase 3)
-- Extends the minimal hr_email_templates table into a full, governed template
-- library: stable Template ID (HRET-0001), machine key, description, category,
-- audience, optional event mapping, plain-text alternative, lifecycle status,
-- versioning, and usage analytics. Backward compatible with the existing
-- automation layer, which reads subject/body where status = 'Active'.

CREATE TABLE IF NOT EXISTS hr_email_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body LONGTEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE hr_email_templates
  ADD COLUMN IF NOT EXISTS template_uid VARCHAR(40) NULL,
  ADD COLUMN IF NOT EXISTS template_key VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS description VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS category VARCHAR(60) NOT NULL DEFAULT 'General',
  ADD COLUMN IF NOT EXISTS audience VARCHAR(40) NOT NULL DEFAULT 'Employee',
  ADD COLUMN IF NOT EXISTS event_key VARCHAR(60) NULL,
  ADD COLUMN IF NOT EXISTS body_text LONGTEXT NULL,
  ADD COLUMN IF NOT EXISTS version INT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS usage_count INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS attachment_size INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS created_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS updated_by BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Full lifecycle. Existing 'Active' rows stay valid.
ALTER TABLE hr_email_templates
  MODIFY COLUMN status ENUM('Draft','Active','Inactive','Archived') NOT NULL DEFAULT 'Draft';

CREATE UNIQUE INDEX uq_hr_email_templates_uid ON hr_email_templates (template_uid);
CREATE UNIQUE INDEX uq_hr_email_templates_key ON hr_email_templates (template_key);
CREATE INDEX idx_hr_email_templates_status ON hr_email_templates (status);
CREATE INDEX idx_hr_email_templates_category ON hr_email_templates (category);

-- Immutable snapshot of every saved revision for audit / rollback.
CREATE TABLE IF NOT EXISTS hr_email_template_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body LONGTEXT NOT NULL,
  body_text LONGTEXT NULL,
  category VARCHAR(60) NULL,
  audience VARCHAR(40) NULL,
  status VARCHAR(20) NULL,
  changed_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_hr_email_template_versions_tpl (template_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-13-upgrade-hr-shift-rotations.sql
-- Productionise Shift Rotations. Additive & idempotent â€” mirrors the runtime
-- schema-ensure in lib/hr-shift-rotations.ts so the feature works before this
-- file is applied by hand. Every new column is nullable / defaulted so legacy
-- rows created by the old generic form keep resolving.

-- Rotation header: business code, effective window, ownership + audit stamps,
-- timezone and a pointer to the current pattern version.
ALTER TABLE hr_shift_rotations ADD COLUMN rotation_code VARCHAR(40) DEFAULT NULL;
ALTER TABLE hr_shift_rotations ADD COLUMN effective_from DATE DEFAULT NULL;
ALTER TABLE hr_shift_rotations ADD COLUMN effective_until DATE DEFAULT NULL;
ALTER TABLE hr_shift_rotations ADD COLUMN time_zone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE hr_shift_rotations ADD COLUMN current_version_no INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE hr_shift_rotations ADD COLUMN created_by_name VARCHAR(150) DEFAULT NULL;
ALTER TABLE hr_shift_rotations ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL;

-- Effective-dated pattern versions. Editing a running rotation's pattern never
-- rewrites history â€” it creates a new version with a future effective_from.
CREATE TABLE IF NOT EXISTS hr_shift_rotation_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_id VARCHAR(50) NOT NULL,
  rotation_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  effective_from DATE NOT NULL,
  cycle_type ENUM('Days','Weeks','Months') NOT NULL DEFAULT 'Weeks',
  cycle_length INT UNSIGNED NOT NULL DEFAULT 1,
  notes VARCHAR(500) DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_by_name VARCHAR(150) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rotation_version (version_id),
  UNIQUE KEY uq_rotation_version_no (rotation_id, version_no),
  KEY idx_rotation_version_eff (rotation_id, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sequences now belong to a version. unit_span is the raw entered span in the
-- cycle unit (days/weeks/months); duration_days is retained for back-compat.
ALTER TABLE hr_shift_rotation_sequences ADD COLUMN version_id BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE hr_shift_rotation_sequences ADD COLUMN unit_span INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE hr_shift_rotation_sequences ADD COLUMN is_weekly_off TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE hr_shift_rotation_sequences ADD COLUMN label VARCHAR(120) DEFAULT NULL;
CREATE INDEX idx_rotation_seq_version ON hr_shift_rotation_sequences (version_id, sequence_no);

-- Membership gets an end_date (rotations stop naturally / offboarded employees
-- drop off) plus ownership + audit stamps.
ALTER TABLE hr_shift_rotation_employees ADD COLUMN end_date DATE DEFAULT NULL;
ALTER TABLE hr_shift_rotation_employees ADD COLUMN added_by BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE hr_shift_rotation_employees ADD COLUMN added_by_name VARCHAR(150) DEFAULT NULL;
ALTER TABLE hr_shift_rotation_employees ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE hr_shift_rotation_employees ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL;
CREATE INDEX idx_rotation_emp_window ON hr_shift_rotation_employees (employee_id, start_date, end_date);

-- Per-rotation audit trail (mirrors hr_shift_assignment_events).
CREATE TABLE IF NOT EXISTS hr_shift_rotation_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rotation_id VARCHAR(50) NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  summary VARCHAR(255) NOT NULL,
  changes JSON DEFAULT NULL,
  reason VARCHAR(500) DEFAULT NULL,
  actor_id BIGINT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(150) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rotation_event_ref (rotation_id, created_at),
  KEY idx_rotation_event_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- RBAC features.
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Manage Shift Rotations','hr.manage_shift_rotations','Create, edit, version and end shift rotations',19 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Override Shift Rotation Conflicts','hr.override_shift_rotations','Override overlapping rotation membership conflicts',20 FROM modules WHERE slug='hr';



-- FILE: 2026-09-14-add-email-attachments-storage.sql
-- Stores uploaded email-template attachments directly in the database
-- (the "Email Attachment" folder), so uploads work without external blob storage.
CREATE TABLE IF NOT EXISTS email_attachments (
  id CHAR(36) NOT NULL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(150) NOT NULL,
  size INT NOT NULL,
  data LONGBLOB NOT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-14-add-legal-module.sql
-- Legal module: Contracts and Esign sub-modules.
-- Adds the top-level "Legal" workspace module plus its two feature slugs
-- (legal.view_contracts, legal.view_esign) so it appears in the sidebar and
-- the employee permission matrix.

-- Register the Legal module (idempotent).
INSERT INTO modules (name, slug, description, icon, sort_order)
SELECT 'Legal', 'legal', 'Contracts and e-signature workflows.', 'scale', 41
FROM dual
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'legal');

-- Feature slugs used for sidebar + page gating.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Contracts', 'legal.view_contracts', 'View and manage legal contracts', 1 FROM modules WHERE slug = 'legal';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Esign', 'legal.view_esign', 'View and manage e-signature requests', 2 FROM modules WHERE slug = 'legal';



-- FILE: 2026-09-15-add-employee-bank-details.sql
-- Add employee bank detail columns to hr_employees.
-- Safe to run multiple times: each column is added only if it does not already exist.

ALTER TABLE `hr_employees`
  ADD COLUMN IF NOT EXISTS `bank_account_holder_name` VARCHAR(150) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_name` VARCHAR(150) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_account_number` VARCHAR(50) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_ifsc_code` VARCHAR(30) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_branch` VARCHAR(150) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_account_type` VARCHAR(40) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_swift_code` VARCHAR(30) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_pan_number` VARCHAR(20) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_upi_id` VARCHAR(120) DEFAULT NULL;



-- FILE: 2026-09-15-journal-cost-centre.sql
-- Journal Entries central-accounting upgrade (Phases 31â€“35).
--
-- Adds the cost-centre dimension to the two tables the manual journal engine
-- writes: journal_entries (the unposted voucher) and general_ledger (the posted
-- ledger line). Party and project columns already exist on both tables from
-- 2026-09-08-add-journal-ledger-reports.sql, so only cost_centre is new here.
--
-- The engine also applies these lazily at runtime (ensureManualJournalColumns in
-- lib/finance-journal.ts) so installs that never run this migration still
-- upgrade in place; this file keeps the schema self-documenting.
--
-- Idempotent ADD COLUMN via a temporary stored procedure (MySQL lacks
-- ADD COLUMN IF NOT EXISTS), mirroring 2026-09-30-purchase-bill-master-upgrade.sql.

DROP PROCEDURE IF EXISTS `__je_add_column`;
DELIMITER //
CREATE PROCEDURE `__je_add_column`(IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = tbl AND column_name = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN ', ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL `__je_add_column`('journal_entries', 'cost_centre', 'cost_centre VARCHAR(120) DEFAULT NULL');
CALL `__je_add_column`('general_ledger',  'cost_centre', 'cost_centre VARCHAR(120) DEFAULT NULL');

-- Reversal link columns the engine also ensures lazily (see finance-journal.ts).
CALL `__je_add_column`('journal_entries', 'reversal_of', 'reversal_of VARCHAR(40) DEFAULT NULL');
CALL `__je_add_column`('journal_entries', 'reversed_by', 'reversed_by VARCHAR(40) DEFAULT NULL');

DROP PROCEDURE IF EXISTS `__je_add_column`;



-- FILE: 2026-09-16-add-employee-photo.sql
-- Adds an employee photo/picture column to hr_employees.
-- The image itself is stored (DB-backed) via /api/email-attachments and this
-- column holds the returned download pathname (e.g. /api/email-attachments/{id}).
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS photo_url VARCHAR(255) NULL;



-- FILE: 2026-09-16-finance-fixed-assets.sql
-- =====================================================================
-- Finance > Fixed Assets sub-module â€” full schema
-- ---------------------------------------------------------------------
-- Mirrors the self-healing schema the app builds at runtime:
--   * base `fixed_assets` table  -> lib/finance-ensure.ensureRegisterModuleTables
--   * Phase-3 extra columns       -> lib/finance-fixed-assets.ensureFixedAssetSchema
--   * fixed_asset_depreciation    -> per-period depreciation schedule
--   * fixed_asset_transfers       -> custodian / location transfer history
--
-- Idempotent: safe to run on a fresh DB or an existing one (uses
-- CREATE TABLE IF NOT EXISTS). All accounting still flows Journal -> GL
-- through the shared posting engine; these tables only hold the asset
-- master, its depreciation history and its transfer log.
-- MySQL 8 / InnoDB / utf8mb4.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Asset master (base + Phase-3 columns merged into one definition)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixed_assets (
  id                                INT AUTO_INCREMENT PRIMARY KEY,
  asset_id                          VARCHAR(30)  NOT NULL,
  asset_name                        VARCHAR(255) DEFAULT NULL,
  asset_category                    VARCHAR(80)  DEFAULT NULL,
  acquisition_date                  DATE         DEFAULT NULL,
  financial_year                    VARCHAR(12)  DEFAULT NULL,
  cost                              DECIMAL(16,2) NOT NULL DEFAULT 0,
  funding_source                    VARCHAR(40)  DEFAULT NULL,
  depreciation_method               VARCHAR(40)  DEFAULT NULL,
  useful_life_years                 DECIMAL(6,2) NOT NULL DEFAULT 0,
  salvage_value                     DECIMAL(16,2) NOT NULL DEFAULT 0,
  accumulated_depreciation          DECIMAL(16,2) NOT NULL DEFAULT 0,
  net_book_value                    DECIMAL(16,2) NOT NULL DEFAULT 0,
  location                          VARCHAR(190) DEFAULT NULL,
  custodian                         VARCHAR(190) DEFAULT NULL,
  status                            VARCHAR(30)  NOT NULL DEFAULT 'In Use',
  notes                             TEXT         DEFAULT NULL,

  -- Posting columns (shared voucher engine)
  posting_status                    VARCHAR(20)  NOT NULL DEFAULT 'Unposted',
  voucher_no                        VARCHAR(30)  DEFAULT NULL,
  reversal_voucher_no               VARCHAR(30)  DEFAULT NULL,
  posted_amount                     DECIMAL(16,2) NOT NULL DEFAULT 0,
  posted_snapshot                   LONGTEXT     DEFAULT NULL,
  posted_at                         DATETIME     DEFAULT NULL,

  -- Phase-3 additional columns (ensureFixedAssetSchema)
  asset_type                        VARCHAR(80)  DEFAULT NULL,
  vendor                            VARCHAR(190) DEFAULT NULL,
  purchase_bill                     VARCHAR(60)  DEFAULT NULL,
  purchase_date                     DATE         DEFAULT NULL,
  put_to_use_date                   DATE         DEFAULT NULL,
  quantity                          DECIMAL(14,2) NOT NULL DEFAULT 1,
  gross_cost                        DECIMAL(16,2) NOT NULL DEFAULT 0,
  gst_amount                        DECIMAL(16,2) NOT NULL DEFAULT 0,
  capitalised_cost                  DECIMAL(16,2) NOT NULL DEFAULT 0,
  department                        VARCHAR(120) DEFAULT NULL,
  project                           VARCHAR(120) DEFAULT NULL,
  cost_centre                       VARCHAR(120) DEFAULT NULL,
  depreciation_rate                 DECIMAL(6,2) NOT NULL DEFAULT 0,
  residual_value                    DECIMAL(16,2) NOT NULL DEFAULT 0,
  asset_account                     VARCHAR(40)  DEFAULT NULL,
  accumulated_depreciation_account  VARCHAR(40)  DEFAULT NULL,
  depreciation_expense_account      VARCHAR(40)  DEFAULT NULL,
  documents                         TEXT         DEFAULT NULL,
  capitalised_at                    DATETIME     DEFAULT NULL,
  depreciation_start_date           DATE         DEFAULT NULL,
  last_depreciation_date            DATE         DEFAULT NULL,
  disposal_date                     DATE         DEFAULT NULL,
  disposal_proceeds                 DECIMAL(16,2) NOT NULL DEFAULT 0,
  disposal_mode                     VARCHAR(40)  DEFAULT NULL,
  disposal_voucher_no               VARCHAR(40)  DEFAULT NULL,
  disposal_result                   DECIMAL(16,2) NOT NULL DEFAULT 0,
  archived_at                       DATETIME     DEFAULT NULL,

  created_by                        INT          DEFAULT NULL,
  created_at                        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_fa_id (asset_id),
  KEY idx_fa_fy (financial_year),
  KEY idx_fa_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 2. Per-period depreciation schedule
--    One row per asset + accounting month; the UNIQUE key makes the
--    monthly depreciation run idempotent (a repeat run is a no-op).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixed_asset_depreciation (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  asset_id          VARCHAR(30) NOT NULL,
  period            VARCHAR(7)  NOT NULL,            -- YYYY-MM
  depreciation_date DATE        DEFAULT NULL,
  amount            DECIMAL(16,2) NOT NULL DEFAULT 0,
  method            VARCHAR(40) DEFAULT NULL,
  opening_nbv       DECIMAL(16,2) NOT NULL DEFAULT 0,
  closing_nbv       DECIMAL(16,2) NOT NULL DEFAULT 0,
  voucher_no        VARCHAR(40) DEFAULT NULL,
  financial_year    VARCHAR(12) DEFAULT NULL,
  created_by        INT         DEFAULT NULL,
  created_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fad (asset_id, period),
  KEY idx_fad_asset (asset_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 3. Custodian / location / cost-centre transfer history
--    No accounting impact â€” a pure movement log.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixed_asset_transfers (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  asset_id          VARCHAR(30) NOT NULL,
  transfer_date     DATE        DEFAULT NULL,
  from_location     VARCHAR(190) DEFAULT NULL,
  to_location       VARCHAR(190) DEFAULT NULL,
  from_department   VARCHAR(120) DEFAULT NULL,
  to_department     VARCHAR(120) DEFAULT NULL,
  from_cost_centre  VARCHAR(120) DEFAULT NULL,
  to_cost_centre    VARCHAR(120) DEFAULT NULL,
  from_custodian    VARCHAR(190) DEFAULT NULL,
  to_custodian      VARCHAR(190) DEFAULT NULL,
  notes             TEXT        DEFAULT NULL,
  created_by        INT         DEFAULT NULL,
  created_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_fat_asset (asset_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-17-add-legal-contracts.sql
-- Legal Contracts â€” Template Master, Variable Master, Generated Contracts,
-- audit trail and reminder ledger.
--
-- This mirrors lib/legal-contracts-db.ts (ensureContractTables),
-- lib/legal-contracts-audit.ts (ensureContractEventsSchema) and
-- lib/legal-contracts-scheduler.ts (ensureReminderLedger) so the module works
-- once this migration is applied by hand on Hostinger. Every statement is
-- idempotent (CREATE TABLE IF NOT EXISTS / INSERT IGNORE) and additive only â€”
-- it never drops or narrows an existing column.

-- ---------------------------------------------------------------------------
-- Contract template master
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_contract_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  template_uid VARCHAR(40) NULL,
  name VARCHAR(190) NOT NULL,
  contract_type VARCHAR(80) NOT NULL DEFAULT 'Other',
  category VARCHAR(40) NOT NULL DEFAULT 'Other',
  description VARCHAR(600) NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'manual',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  content LONGTEXT NOT NULL,
  required_variables JSON NULL,
  owner_id BIGINT UNSIGNED NULL,
  usage_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_used_at DATETIME NULL,
  review_date DATE NULL,
  expiry_date DATE NULL,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contract_template_uid (template_uid),
  KEY idx_contract_template_status (status),
  KEY idx_contract_template_type (contract_type),
  KEY idx_contract_template_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Template version history (never overwrite an approved historical version)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_contract_template_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  contract_type VARCHAR(80) NOT NULL DEFAULT 'Other',
  category VARCHAR(40) NOT NULL DEFAULT 'Other',
  source VARCHAR(30) NOT NULL DEFAULT 'manual',
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  content LONGTEXT NOT NULL,
  change_note VARCHAR(500) NULL,
  changed_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_contract_tpl_ver (template_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Variable master (configurable, in addition to the built-in catalog)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_contract_variables (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  var_key VARCHAR(80) NOT NULL,
  display_name VARCHAR(150) NOT NULL,
  data_source VARCHAR(40) NOT NULL DEFAULT 'manual',
  field VARCHAR(120) NULL,
  grp VARCHAR(60) NOT NULL DEFAULT 'General',
  required TINYINT(1) NOT NULL DEFAULT 0,
  description VARCHAR(400) NULL,
  example_value VARCHAR(190) NULL,
  is_builtin TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contract_var_key (var_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Generated contracts (actual documents produced from a template)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_generated_contracts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contract_uid VARCHAR(40) NOT NULL,
  reference_no VARCHAR(60) NULL,
  title VARCHAR(220) NOT NULL,
  template_id BIGINT UNSIGNED NULL,
  template_version INT UNSIGNED NULL,
  contract_type VARCHAR(80) NOT NULL DEFAULT 'Other',
  category VARCHAR(40) NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'manual',
  source_ref VARCHAR(80) NULL,
  party_type VARCHAR(40) NULL,
  party_name VARCHAR(190) NULL,
  party_id VARCHAR(80) NULL,
  content LONGTEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Generated',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  effective_date DATE NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  renewal_date DATE NULL,
  document_id INT UNSIGNED NULL,
  variables_snapshot JSON NULL,
  supersedes_id BIGINT UNSIGNED NULL,
  superseded_by BIGINT UNSIGNED NULL,
  dedupe_key VARCHAR(190) NULL,
  generated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_generated_contract_uid (contract_uid),
  UNIQUE KEY uq_generated_contract_reference (reference_no),
  UNIQUE KEY uq_generated_contract_dedupe (dedupe_key),
  KEY idx_generated_contract_status (status),
  KEY idx_generated_contract_source (source, source_ref),
  KEY idx_generated_contract_template (template_id, template_version),
  KEY idx_generated_contract_expiry (end_date),
  KEY idx_generated_contract_renewal (renewal_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Audit trail â€” one row per meaningful action on a template or contract
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_contract_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity_type VARCHAR(20) NOT NULL,
  entity_id BIGINT UNSIGNED NOT NULL,
  entity_ref VARCHAR(60) DEFAULT NULL,
  event_type VARCHAR(60) NOT NULL,
  summary VARCHAR(300) NOT NULL,
  detail JSON DEFAULT NULL,
  actor_id BIGINT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(150) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_legal_event_entity (entity_type, entity_id, created_at),
  KEY idx_legal_event_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Reminder ledger â€” makes the cron scheduler idempotent. Each reminder that
-- has already fired stores its dedupe key here so a re-run never double-sends.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_contract_reminders (
  dedupe_key VARCHAR(190) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dedupe_key),
  KEY idx_legal_reminder_kind (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Sidebar features (RBAC-gated, like the rest of the Legal module)
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Contract Templates', 'legal.view_contract_templates', 'Create and manage contract templates', 3
  FROM modules WHERE slug = 'legal';

-- ---------------------------------------------------------------------------
-- Seed a handful of built-in variables so the Variable Master is not empty.
-- The application also ships a code-level catalog (legal-contracts-shared.ts);
-- these rows simply make the configurable master usable out of the box.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO legal_contract_variables (var_key, display_name, data_source, grp, required, description, example_value, is_builtin) VALUES
  ('company_name', 'Company name', 'company', 'Company', 1, 'Registered company name', 'Muenot Technologies Pvt Ltd', 1),
  ('company_gstin', 'Company GSTIN', 'company', 'Company', 0, 'Company GST identification number', '29ABCDE1234F1Z5', 1),
  ('authorized_signatory', 'Authorized signatory', 'company', 'Company', 0, 'Person signing for the company', 'Sandeep Kumar', 1),
  ('employee_name', 'Employee name', 'employee', 'Employee', 1, 'Full name of the employee', 'Sandeep Kumar', 1),
  ('designation', 'Designation', 'employee', 'Employee', 0, 'Employee designation', 'Software Engineer', 1),
  ('joining_date', 'Joining date', 'employee', 'Employee', 0, 'Date of joining', '01 April 2026', 1),
  ('client_name', 'Client contact name', 'client', 'Client', 0, 'Primary client contact', 'Acme Corp', 1),
  ('client_gstin', 'Client GSTIN', 'client', 'Client', 0, 'Client GST identification number', '27AACCA1234A1Z2', 1),
  ('vendor_name', 'Vendor name', 'vendor', 'Vendor', 0, 'Vendor legal / trade name', 'Globex Supplies', 1),
  ('contract_start_date', 'Start date', 'contract', 'Contract', 0, 'Contract start date', '01 April 2026', 1),
  ('contract_end_date', 'End date', 'contract', 'Contract', 0, 'Contract end date', '31 March 2027', 1);



-- FILE: 2026-09-17-add-sales-calling.sql
-- =============================================================
-- Migration: Sales In-Browser Calling (Twilio Voice)
-- Run this in phpMyAdmin (Hostinger) after the base schema.
-- Safe to run once. Uses IF NOT EXISTS where possible.
-- =============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -------------------------------------------------------------
-- Table: sales_calls
-- One row per call placed to a lead from the browser dialer.
-- `twilio_call_sid` links the row to the Twilio call so status
-- and duration can be reconciled. `disposition` + `notes` capture
-- the outcome the employee records after hanging up.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_calls` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lead_id` INT UNSIGNED DEFAULT NULL,
  `to_number` VARCHAR(40) NOT NULL,
  `to_name` VARCHAR(190) DEFAULT NULL,
  `from_number` VARCHAR(40) DEFAULT NULL,
  `twilio_call_sid` VARCHAR(64) DEFAULT NULL,
  `direction` ENUM('Outbound','Inbound') NOT NULL DEFAULT 'Outbound',
  `status` ENUM('Initiated','Ringing','In Progress','Completed','Failed','Busy','No Answer','Canceled') NOT NULL DEFAULT 'Initiated',
  `duration_seconds` INT UNSIGNED NOT NULL DEFAULT 0,
  `disposition` VARCHAR(80) DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `called_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_calls_lead` (`lead_id`),
  KEY `idx_calls_status` (`status`),
  KEY `idx_calls_sid` (`twilio_call_sid`),
  CONSTRAINT `fk_calls_lead` FOREIGN KEY (`lead_id`) REFERENCES `sales_leads` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_calls_called_by` FOREIGN KEY (`called_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- -------------------------------------------------------------
-- New Sales feature (permission). module_id = 2 is Sales.
-- -------------------------------------------------------------
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT 2, 'Make Calls', 'sales.make_calls', 'Call leads directly from the browser', 16
WHERE NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'sales.make_calls');



-- FILE: 2026-09-17-expand-operations-submodules.sql
-- =============================================================================
-- Operations Module â€” Phase: complete sub-module expansion
-- -----------------------------------------------------------------------------
-- Adds the 25 record tables behind the new hierarchical Operations sidebar.
-- Every table follows the existing operations_* convention:
--   * INT AUTO_INCREMENT primary key `id`
--   * a `status` column (rendered in the generic Operations table view)
--   * `created_by` (used by record-level permission scoping / self-heal)
--   * `created_at` / `updated_at` timestamps
--
-- Safe to run more than once: every statement uses IF NOT EXISTS. No existing
-- Operations table is touched, so current data and pages are preserved.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Projects group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_milestones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  milestone_name VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  planned_start DATE DEFAULT NULL,
  planned_end DATE DEFAULT NULL,
  actual_start DATE DEFAULT NULL,
  actual_end DATE DEFAULT NULL,
  completion_percent DECIMAL(6,2) DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_deliverables (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  deliverable_name VARCHAR(255) DEFAULT NULL,
  milestone_id VARCHAR(191) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  deliverable_type VARCHAR(128) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  submitted_date DATE DEFAULT NULL,
  accepted_date DATE DEFAULT NULL,
  version VARCHAR(64) DEFAULT NULL,
  quality_status VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_project_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  document_name VARCHAR(255) DEFAULT NULL,
  document_type VARCHAR(128) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  version VARCHAR(64) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  document_url VARCHAR(512) DEFAULT NULL,
  effective_date DATE DEFAULT NULL,
  expiry_date DATE DEFAULT NULL,
  confidentiality VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Work Management group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  task_title VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  task_type VARCHAR(128) DEFAULT NULL,
  assigned_to VARCHAR(255) DEFAULT NULL,
  reporter VARCHAR(255) DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  start_date DATE DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  estimated_hours DECIMAL(8,2) DEFAULT NULL,
  actual_hours DECIMAL(8,2) DEFAULT NULL,
  completion_percent DECIMAL(6,2) DEFAULT NULL,
  board_stage VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_work_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  work_order_no VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  title VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  work_type VARCHAR(128) DEFAULT NULL,
  assigned_to VARCHAR(255) DEFAULT NULL,
  requested_by VARCHAR(255) DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  start_date DATE DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  estimated_cost DECIMAL(14,2) DEFAULT NULL,
  actual_cost DECIMAL(14,2) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Resources group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_resource_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  requested_by VARCHAR(255) DEFAULT NULL,
  resource_type VARCHAR(128) DEFAULT NULL,
  skill_category VARCHAR(128) DEFAULT NULL,
  required_skills VARCHAR(512) DEFAULT NULL,
  quantity INT DEFAULT NULL,
  allocation_percent DECIMAL(6,2) DEFAULT NULL,
  required_from DATE DEFAULT NULL,
  required_to DATE DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  justification TEXT DEFAULT NULL,
  approver VARCHAR(255) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_skill_matrix (
  id INT AUTO_INCREMENT PRIMARY KEY,
  resource_id VARCHAR(191) DEFAULT NULL,
  resource_name VARCHAR(255) DEFAULT NULL,
  department VARCHAR(128) DEFAULT NULL,
  skill_category VARCHAR(128) DEFAULT NULL,
  skill_name VARCHAR(255) DEFAULT NULL,
  proficiency_level VARCHAR(64) DEFAULT NULL,
  experience_years DECIMAL(5,1) DEFAULT NULL,
  certification VARCHAR(255) DEFAULT NULL,
  last_assessed DATE DEFAULT NULL,
  assessed_by VARCHAR(255) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_capacity_planning (
  id INT AUTO_INCREMENT PRIMARY KEY,
  period VARCHAR(64) DEFAULT NULL,
  department VARCHAR(128) DEFAULT NULL,
  resource_type VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  planned_capacity DECIMAL(10,2) DEFAULT NULL,
  allocated_capacity DECIMAL(10,2) DEFAULT NULL,
  available_capacity DECIMAL(10,2) DEFAULT NULL,
  demand_forecast DECIMAL(10,2) DEFAULT NULL,
  utilization_target DECIMAL(6,2) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_utilization (
  id INT AUTO_INCREMENT PRIMARY KEY,
  resource_id VARCHAR(191) DEFAULT NULL,
  resource_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  billable_hours DECIMAL(8,2) DEFAULT NULL,
  non_billable_hours DECIMAL(8,2) DEFAULT NULL,
  available_hours DECIMAL(8,2) DEFAULT NULL,
  utilization_percent DECIMAL(6,2) DEFAULT NULL,
  billable_percent DECIMAL(6,2) DEFAULT NULL,
  target_utilization DECIMAL(6,2) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Timesheets group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_timesheets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  resource_id VARCHAR(191) DEFAULT NULL,
  resource_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  task_id VARCHAR(191) DEFAULT NULL,
  work_date DATE DEFAULT NULL,
  hours_worked DECIMAL(8,2) DEFAULT NULL,
  billable_hours DECIMAL(8,2) DEFAULT NULL,
  activity_type VARCHAR(128) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  approved_by VARCHAR(255) DEFAULT NULL,
  approval_status VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Quality & SLA group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_qa_audits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  audit_no VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  audit_type VARCHAR(128) DEFAULT NULL,
  audit_scope VARCHAR(512) DEFAULT NULL,
  auditor VARCHAR(255) DEFAULT NULL,
  audit_date DATE DEFAULT NULL,
  findings TEXT DEFAULT NULL,
  non_conformities TEXT DEFAULT NULL,
  severity VARCHAR(64) DEFAULT NULL,
  score DECIMAL(6,2) DEFAULT NULL,
  corrective_action_required VARCHAR(64) DEFAULT NULL,
  closure_date DATE DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_sla_monitoring (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  sla_metric VARCHAR(255) DEFAULT NULL,
  sla_target VARCHAR(128) DEFAULT NULL,
  actual_value VARCHAR(128) DEFAULT NULL,
  unit VARCHAR(64) DEFAULT NULL,
  measurement_period VARCHAR(64) DEFAULT NULL,
  breach_count INT DEFAULT NULL,
  penalty DECIMAL(14,2) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  review_date DATE DEFAULT NULL,
  sla_status VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_corrective_actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reference_no VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  source_type VARCHAR(128) DEFAULT NULL,
  issue_summary TEXT DEFAULT NULL,
  root_cause TEXT DEFAULT NULL,
  corrective_action TEXT DEFAULT NULL,
  preventive_action TEXT DEFAULT NULL,
  action_owner VARCHAR(255) DEFAULT NULL,
  target_date DATE DEFAULT NULL,
  closure_date DATE DEFAULT NULL,
  effectiveness VARCHAR(128) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Issues group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_escalations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  escalation_no VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  raised_by VARCHAR(255) DEFAULT NULL,
  escalation_level VARCHAR(64) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  impact TEXT DEFAULT NULL,
  assigned_to VARCHAR(255) DEFAULT NULL,
  raised_date DATE DEFAULT NULL,
  target_resolution DATE DEFAULT NULL,
  resolution TEXT DEFAULT NULL,
  closure_date DATE DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_root_cause_capa (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reference_no VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  problem_statement TEXT DEFAULT NULL,
  analysis_method VARCHAR(128) DEFAULT NULL,
  root_cause TEXT DEFAULT NULL,
  capa_type VARCHAR(64) DEFAULT NULL,
  corrective_action TEXT DEFAULT NULL,
  preventive_action TEXT DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  target_date DATE DEFAULT NULL,
  verification_date DATE DEFAULT NULL,
  effectiveness VARCHAR(128) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Process Management group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_sops (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sop_code VARCHAR(128) DEFAULT NULL,
  title VARCHAR(255) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  department VARCHAR(128) DEFAULT NULL,
  version VARCHAR(64) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  effective_date DATE DEFAULT NULL,
  review_date DATE DEFAULT NULL,
  next_review_date DATE DEFAULT NULL,
  approval_status VARCHAR(64) DEFAULT NULL,
  document_url VARCHAR(512) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_checklists (
  id INT AUTO_INCREMENT PRIMARY KEY,
  checklist_name VARCHAR(255) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  linked_sop VARCHAR(128) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  total_items INT DEFAULT NULL,
  completed_items INT DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  completion_percent DECIMAL(6,2) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  approval_no VARCHAR(128) DEFAULT NULL,
  request_type VARCHAR(128) DEFAULT NULL,
  related_to VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  requested_by VARCHAR(255) DEFAULT NULL,
  approver VARCHAR(255) DEFAULT NULL,
  request_date DATE DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  decision VARCHAR(64) DEFAULT NULL,
  decision_date DATE DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Client Operations group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_client_requirements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  requirement_title VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  requirement_type VARCHAR(128) DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  source VARCHAR(128) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  received_date DATE DEFAULT NULL,
  target_date DATE DEFAULT NULL,
  acceptance_criteria TEXT DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_client_deliverables (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  deliverable_name VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  deliverable_type VARCHAR(128) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  submitted_date DATE DEFAULT NULL,
  acceptance_date DATE DEFAULT NULL,
  acceptance_status VARCHAR(64) DEFAULT NULL,
  version VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_client_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  approval_item VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  submitted_to VARCHAR(255) DEFAULT NULL,
  submitted_date DATE DEFAULT NULL,
  approver_name VARCHAR(255) DEFAULT NULL,
  decision VARCHAR(64) DEFAULT NULL,
  decision_date DATE DEFAULT NULL,
  feedback TEXT DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Finance group (Operations cost tracking â€” feeds, never duplicates, Finance)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_project_cost (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  cost_category VARCHAR(128) DEFAULT NULL,
  cost_head VARCHAR(128) DEFAULT NULL,
  budgeted_cost DECIMAL(14,2) DEFAULT NULL,
  actual_cost DECIMAL(14,2) DEFAULT NULL,
  committed_cost DECIMAL(14,2) DEFAULT NULL,
  variance DECIMAL(14,2) DEFAULT NULL,
  currency VARCHAR(16) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  cost_date DATE DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_resource_cost (
  id INT AUTO_INCREMENT PRIMARY KEY,
  resource_id VARCHAR(191) DEFAULT NULL,
  resource_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  cost_type VARCHAR(128) DEFAULT NULL,
  rate DECIMAL(14,2) DEFAULT NULL,
  rate_type VARCHAR(64) DEFAULT NULL,
  hours DECIMAL(8,2) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  total_cost DECIMAL(14,2) DEFAULT NULL,
  currency VARCHAR(16) DEFAULT NULL,
  billable VARCHAR(32) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_vendor_cost (
  id INT AUTO_INCREMENT PRIMARY KEY,
  vendor_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  service_category VARCHAR(128) DEFAULT NULL,
  po_number VARCHAR(128) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  invoice_amount DECIMAL(14,2) DEFAULT NULL,
  paid_amount DECIMAL(14,2) DEFAULT NULL,
  currency VARCHAR(16) DEFAULT NULL,
  invoice_date DATE DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  payment_status VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_budget_vs_actual (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  budget_amount DECIMAL(14,2) DEFAULT NULL,
  actual_amount DECIMAL(14,2) DEFAULT NULL,
  variance DECIMAL(14,2) DEFAULT NULL,
  variance_percent DECIMAL(6,2) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  currency VARCHAR(16) DEFAULT NULL,
  forecast_amount DECIMAL(14,2) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);



-- FILE: 2026-09-17-operations-finance-versioning-checklists.sql
-- =============================================================================
-- Operations Module â€” Finance derivation, SOP versioning, Checklist items,
-- Client-approval audit.
-- -----------------------------------------------------------------------------
-- This migration is purely ADDITIVE. It never drops or rewrites an existing
-- Operations table, so all current data and pages are preserved.
--
--   * operations_projects gains a single `budget_amount` planning field so the
--     Budget vs Actual report has one authoritative budget source (no duplicate
--     Finance/budget system is introduced).
--   * operations_sop_versions keeps an immutable history snapshot every time an
--     SOP is created or edited, so previous versions are never lost (Phase 33).
--   * operations_checklist_items stores per-item Pending/Completed/Not
--     Applicable states; the parent checklist's completion % is auto-derived
--     from these rows (Phases 34-35).
--   * operations_client_approvals gains `decided_by` / `decided_at` so every
--     approve/reject decision is stamped with the acting user + timestamp
--     automatically (Phase 40).
--
-- MySQL has no "ADD COLUMN IF NOT EXISTS"; the application self-heals these
-- columns at runtime via lib/operations-ensure.ts using information_schema, so
-- an install that has not run this file degrades gracefully. New tables use
-- IF NOT EXISTS and are safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Phase 45 â€” Projects: authoritative planning budget for Budget vs Actual
-- Guarded so re-running (or running after runtime self-heal) is a no-op.
-- ---------------------------------------------------------------------------
SET @ops_has_budget_amount := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operations_projects'
    AND COLUMN_NAME = 'budget_amount'
);
SET @ops_sql := IF(@ops_has_budget_amount = 0,
  'ALTER TABLE `operations_projects` ADD COLUMN `budget_amount` DECIMAL(14,2) NULL AFTER `billing_model`',
  'DO 0');
PREPARE ops_stmt FROM @ops_sql;
EXECUTE ops_stmt;
DEALLOCATE PREPARE ops_stmt;

-- ---------------------------------------------------------------------------
-- Phase 33 â€” SOP version history (immutable snapshots)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_sop_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sop_id INT NOT NULL,
  sop_code VARCHAR(128) DEFAULT NULL,
  version VARCHAR(64) DEFAULT NULL,
  title VARCHAR(255) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  department VARCHAR(128) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  effective_date DATE DEFAULT NULL,
  review_date DATE DEFAULT NULL,
  next_review_date DATE DEFAULT NULL,
  approval_status VARCHAR(64) DEFAULT NULL,
  document_url VARCHAR(512) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  change_type VARCHAR(32) DEFAULT NULL,
  snapshot_by INT UNSIGNED DEFAULT NULL,
  snapshot_by_name VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sop_versions_sop (sop_id),
  KEY idx_sop_versions_created (created_at)
);

-- ---------------------------------------------------------------------------
-- Phases 34-35 â€” Checklist items (drive the parent checklist completion %)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_checklist_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  checklist_id INT NOT NULL,
  item_text VARCHAR(512) DEFAULT NULL,
  sort_order INT DEFAULT NULL,
  item_status VARCHAR(32) DEFAULT 'Pending',
  completed_by VARCHAR(255) DEFAULT NULL,
  completed_at DATETIME DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_checklist_items_checklist (checklist_id)
);

-- ---------------------------------------------------------------------------
-- Phase 40 â€” Client approvals: audit stamp on decision
-- Each column guarded independently so a partial prior run self-heals.
-- ---------------------------------------------------------------------------
SET @ops_has_decided_by := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operations_client_approvals'
    AND COLUMN_NAME = 'decided_by'
);
SET @ops_sql := IF(@ops_has_decided_by = 0,
  'ALTER TABLE `operations_client_approvals` ADD COLUMN `decided_by` VARCHAR(255) NULL AFTER `decision_date`',
  'DO 0');
PREPARE ops_stmt FROM @ops_sql;
EXECUTE ops_stmt;
DEALLOCATE PREPARE ops_stmt;

SET @ops_has_decided_at := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'operations_client_approvals'
    AND COLUMN_NAME = 'decided_at'
);
SET @ops_sql := IF(@ops_has_decided_at = 0,
  'ALTER TABLE `operations_client_approvals` ADD COLUMN `decided_at` DATETIME NULL AFTER `decided_by`',
  'DO 0');
PREPARE ops_stmt FROM @ops_sql;
EXECUTE ops_stmt;
DEALLOCATE PREPARE ops_stmt;



-- FILE: 2026-09-17-operations-sync-and-productivity.sql
-- =============================================================================
-- Operations Module â€” Phases 16-25: Sync, Productivity, Scorecards, SLA tracking
-- -----------------------------------------------------------------------------
-- Extends the existing Operations sub-modules with the connective tissue the
-- earlier phases only scaffolded:
--   * Timesheets gain Start/End time + explicit non-billable hours (Phase 17).
--   * SLA Monitoring gains due/actual/delay tracking for auto breach detection
--     (Phase 23).
--   * A derived Productivity table (Phase 21) populated from Tasks, Timesheets,
--     Projects and Deliverables â€” never static values.
--   * Configurable Quality Scorecards + weighted criteria (Phases 22 & 24) with
--     an auto-calculated total.
--
-- No existing Operations table is dropped or replaced. Column additions use the
-- project's established "run once" convention (MySQL has no ADD COLUMN IF NOT
-- EXISTS); application code guards every new column with tableColumns() so an
-- install that has not run this migration degrades gracefully instead of
-- crashing. New tables use IF NOT EXISTS and are safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Phase 17 â€” Timesheets: Start/End time + non-billable hours
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_timesheets`
  ADD COLUMN `start_time`         TIME          NULL AFTER `work_date`,
  ADD COLUMN `end_time`           TIME          NULL AFTER `start_time`,
  ADD COLUMN `non_billable_hours` DECIMAL(8,2)  NULL AFTER `billable_hours`;

-- ---------------------------------------------------------------------------
-- Phase 23 â€” SLA Monitoring: due date, actual completion, computed delay
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_sla_monitoring`
  ADD COLUMN `due_date`          DATE  NULL AFTER `measurement_period`,
  ADD COLUMN `actual_completion` DATE  NULL AFTER `due_date`,
  ADD COLUMN `delay_days`        INT   NULL AFTER `actual_completion`;

-- ---------------------------------------------------------------------------
-- Phase 21 â€” Productivity (derived from Tasks + Timesheets + Deliverables)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_productivity (
  id INT AUTO_INCREMENT PRIMARY KEY,
  resource_id VARCHAR(191) DEFAULT NULL,
  resource_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  tasks_assigned INT DEFAULT NULL,
  tasks_completed INT DEFAULT NULL,
  deliverables_completed INT DEFAULT NULL,
  estimated_hours DECIMAL(10,2) DEFAULT NULL,
  logged_hours DECIMAL(10,2) DEFAULT NULL,
  billable_hours DECIMAL(10,2) DEFAULT NULL,
  task_completion_percent DECIMAL(6,2) DEFAULT NULL,
  efficiency_percent DECIMAL(6,2) DEFAULT NULL,
  billable_percent DECIMAL(6,2) DEFAULT NULL,
  productivity_score DECIMAL(6,2) DEFAULT NULL,
  source VARCHAR(32) DEFAULT 'derived',
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_productivity_resource_period (resource_id, period),
  KEY idx_productivity_period (period)
);

-- ---------------------------------------------------------------------------
-- Phases 22 & 24 â€” Quality Scorecards + configurable weighted criteria
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_scorecards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  scorecard_no VARCHAR(128) DEFAULT NULL,
  scorecard_type VARCHAR(64) DEFAULT NULL,
  subject_type VARCHAR(64) DEFAULT NULL,
  subject_id VARCHAR(191) DEFAULT NULL,
  subject_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  review_date DATE DEFAULT NULL,
  reviewer VARCHAR(255) DEFAULT NULL,
  total_score DECIMAL(10,2) DEFAULT NULL,
  max_score DECIMAL(10,2) DEFAULT NULL,
  score_percent DECIMAL(6,2) DEFAULT NULL,
  result VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_scorecard_subject (subject_type, subject_id),
  KEY idx_scorecard_project (project_id)
);

CREATE TABLE IF NOT EXISTS operations_scorecard_criteria (
  id INT AUTO_INCREMENT PRIMARY KEY,
  scorecard_id VARCHAR(191) DEFAULT NULL,
  criteria_name VARCHAR(255) DEFAULT NULL,
  weight DECIMAL(6,2) DEFAULT NULL,
  max_score DECIMAL(6,2) DEFAULT NULL,
  score DECIMAL(6,2) DEFAULT NULL,
  weighted_score DECIMAL(10,2) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_criteria_scorecard (scorecard_id)
);

-- ---------------------------------------------------------------------------
-- Feature slugs so the new sub-modules appear in the permission matrix and are
-- gated by the sidebar. IGNORE keeps this idempotent.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Productivity', 'operations.view_productivity', 'View operations productivity', 60 FROM modules WHERE slug = 'operations';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Quality Scorecards', 'operations.view_scorecards', 'View quality scorecards', 61 FROM modules WHERE slug = 'operations';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Scorecard Criteria', 'operations.view_scorecard_criteria', 'View scorecard criteria', 62 FROM modules WHERE slug = 'operations';



-- FILE: 2026-09-17-upgrade-hr-shift-change-requests.sql
-- Upgrade Shift Change Requests into a controlled, auditable shift-change
-- workflow. Additive only: every column is nullable / defaulted so existing
-- rows and the older generic form keep working. The lib/hr-shift-change.ts
-- `ensureShiftChangeSchema()` helper applies the same changes idempotently at
-- runtime (MySQL has no ADD COLUMN IF NOT EXISTS), so this file is the record
-- of intent and can be run manually against a fresh database.

-- 1. Request columns ---------------------------------------------------------
ALTER TABLE hr_shift_change_requests ADD COLUMN employee_name VARCHAR(150) DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN change_type ENUM('Temporary','Permanent') NOT NULL DEFAULT 'Permanent';
ALTER TABLE hr_shift_change_requests ADD COLUMN reason_category VARCHAR(60) DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN attachment_url VARCHAR(500) DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN attachment_name VARCHAR(255) DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN approver_id BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN approver_name VARCHAR(150) DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN created_by BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE hr_shift_change_requests ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN applied_assignment_id VARCHAR(50) DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN cancelled_at DATETIME NULL DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN cancelled_by BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN cancel_reason VARCHAR(500) DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN withdrawn_at DATETIME NULL DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN support_ticket_id VARCHAR(50) DEFAULT NULL;
ALTER TABLE hr_shift_change_requests ADD COLUMN is_override TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE hr_shift_change_requests ADD COLUMN override_reason VARCHAR(500) DEFAULT NULL;

-- Add the Withdrawn state to the request lifecycle enum.
ALTER TABLE hr_shift_change_requests
  MODIFY COLUMN status ENUM('Pending','Approved','Rejected','Cancelled','Withdrawn') NOT NULL DEFAULT 'Pending';

-- Helpful indexes for server-side search / conflict scans.
CREATE INDEX idx_scr_status ON hr_shift_change_requests (status);
CREATE INDEX idx_scr_dates ON hr_shift_change_requests (employee_id, from_date, to_date);

-- 2. Traceability from the final assignment back to the originating request ---
ALTER TABLE hr_shift_assignments ADD COLUMN source_request_id VARCHAR(50) DEFAULT NULL;
ALTER TABLE hr_shift_assignments ADD COLUMN change_type ENUM('Temporary','Permanent') DEFAULT NULL;
CREATE INDEX idx_shift_assignment_source ON hr_shift_assignments (source_request_id);

-- 3. Activity timeline + field-level audit for each request -------------------
CREATE TABLE IF NOT EXISTS hr_shift_change_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id VARCHAR(50) NOT NULL,
  employee_id BIGINT UNSIGNED DEFAULT NULL,
  event_type VARCHAR(60) NOT NULL,
  message VARCHAR(500) NOT NULL,
  changes JSON DEFAULT NULL,
  actor_id BIGINT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(150) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_scr_event_request (request_id, created_at),
  KEY idx_scr_event_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. RBAC features ------------------------------------------------------------
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Manage Shift Change Requests','hr.manage_shift_change_requests','Approve, reject and cancel shift change requests',19 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order)
  SELECT id,'Override Shift Change Rules','hr.override_shift_change_requests','Override conflicts / backdated shift changes',20 FROM modules WHERE slug='hr';



-- FILE: 2026-09-18-add-recruit-calling.sql
-- =============================================================
-- Migration: Recruitment In-Browser Calling (Twilio Voice)
-- Run this in phpMyAdmin (Hostinger) after the base schema and the
-- Worksuite recruit module migration.
-- Safe to run once. Uses IF NOT EXISTS where possible.
-- Reuses the same Twilio TwiML App voice webhook as Sales
-- (/api/sales/calls/voice) â€” no extra Twilio config is required.
-- =============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -------------------------------------------------------------
-- Table: recruit_calls
-- One row per call placed to an applicant from the browser dialer.
-- `application_id` links the call to a recruit_applications row when
-- available (calls from the Candidate Database aggregate view leave it
-- NULL). `disposition` + `notes` capture the outcome the recruiter
-- records after hanging up.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `recruit_calls` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `application_id` INT UNSIGNED DEFAULT NULL,
  `to_number` VARCHAR(40) NOT NULL,
  `to_name` VARCHAR(190) DEFAULT NULL,
  `from_number` VARCHAR(40) DEFAULT NULL,
  `twilio_call_sid` VARCHAR(64) DEFAULT NULL,
  `direction` ENUM('Outbound','Inbound') NOT NULL DEFAULT 'Outbound',
  `status` ENUM('Initiated','Ringing','In Progress','Completed','Failed','Busy','No Answer','Canceled') NOT NULL DEFAULT 'Initiated',
  `duration_seconds` INT UNSIGNED NOT NULL DEFAULT 0,
  `disposition` VARCHAR(80) DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `called_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_recruit_calls_app` (`application_id`),
  KEY `idx_recruit_calls_status` (`status`),
  KEY `idx_recruit_calls_sid` (`twilio_call_sid`),
  CONSTRAINT `fk_recruit_calls_app` FOREIGN KEY (`application_id`) REFERENCES `recruit_applications` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_recruit_calls_called_by` FOREIGN KEY (`called_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- -------------------------------------------------------------
-- New Recruitment feature (permission), attached to the recruitment module.
-- -------------------------------------------------------------
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT id, 'Make Calls', 'recruitment.make_calls', 'Call applicants directly from the browser', 9
FROM `modules` WHERE `slug` = 'recruitment'
  AND NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'recruitment.make_calls');



-- FILE: 2026-09-18-approval-authority.sql
-- =============================================================================
-- SPEC 11 â€” Approval Authority
-- -----------------------------------------------------------------------------
-- A configurable, tenant-scoped approval-rule engine. Rules match a request by
-- module, legal entity, department, requester role, and amount range, and carry
-- an ordered set of levels. Levels run sequentially; the approvers within a
-- level combine as all / any / quorum (parallel). Delegation reroutes an
-- approver's authority; escalation adds an approver when a step goes stale.
--
-- The application self-heals these tables at runtime (lib/approval-authority.ts
-- #ensureApprovalSchema), so this migration is the canonical, idempotent record
-- of the schema. Safe to run more than once â€” every statement uses IF NOT
-- EXISTS and no existing table is touched.
-- =============================================================================

-- Rule header: what a rule matches on + how the winner is chosen.
CREATE TABLE IF NOT EXISTS approval_rules (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  module_key VARCHAR(80) NOT NULL DEFAULT '*',
  active TINYINT(1) NOT NULL DEFAULT 1,
  priority INT NOT NULL DEFAULT 0,
  entity_id INT UNSIGNED DEFAULT NULL,
  department VARCHAR(150) DEFAULT NULL,
  applies_role VARCHAR(150) DEFAULT NULL,
  min_amount DECIMAL(18,2) DEFAULT NULL,
  max_amount DECIMAL(18,2) DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ar_tenant_module (tenant_id, module_key),
  KEY idx_ar_tenant_active (tenant_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ordered approval levels belonging to a rule (sequential by level_no).
CREATE TABLE IF NOT EXISTS approval_rule_levels (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  rule_id INT UNSIGNED NOT NULL,
  level_no INT NOT NULL,
  name VARCHAR(160) DEFAULT NULL,
  mode ENUM('all','any','quorum') NOT NULL DEFAULT 'all',
  quorum INT DEFAULT NULL,
  escalate_after_hours INT DEFAULT NULL,
  escalate_to_kind ENUM('user','role','department','dynamic') DEFAULT NULL,
  escalate_to_value VARCHAR(190) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_rule_level (rule_id, level_no),
  KEY idx_arl_rule (rule_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Approver targets on a level (user / role / department / dynamic).
CREATE TABLE IF NOT EXISTS approval_rule_level_approvers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  level_id INT UNSIGNED NOT NULL,
  kind ENUM('user','role','department','dynamic') NOT NULL,
  value VARCHAR(190) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_arla_level (level_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A live approval request raised by a business module against a record.
CREATE TABLE IF NOT EXISTS approval_requests (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  module_key VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) DEFAULT NULL,
  entity_pk INT UNSIGNED DEFAULT NULL,
  entity_ref VARCHAR(190) DEFAULT NULL,
  title VARCHAR(255) DEFAULT NULL,
  amount DECIMAL(18,2) DEFAULT NULL,
  department VARCHAR(150) DEFAULT NULL,
  requester_role VARCHAR(150) DEFAULT NULL,
  legal_entity_id INT UNSIGNED DEFAULT NULL,
  rule_id INT UNSIGNED DEFAULT NULL,
  status ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  current_level INT DEFAULT NULL,
  requested_by INT UNSIGNED DEFAULT NULL,
  requested_by_name VARCHAR(190) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  decided_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_areq_tenant_status (tenant_id, status),
  KEY idx_areq_entity (tenant_id, entity_type, entity_pk)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-approver step state for a request. One row per resolved approver slot.
CREATE TABLE IF NOT EXISTS approval_request_steps (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id INT UNSIGNED NOT NULL,
  level_no INT NOT NULL,
  level_name VARCHAR(160) DEFAULT NULL,
  mode ENUM('all','any','quorum') NOT NULL DEFAULT 'all',
  quorum INT DEFAULT NULL,
  target_kind ENUM('user','role','department','dynamic') NOT NULL,
  target_value VARCHAR(190) NOT NULL,
  approver_user_id INT UNSIGNED DEFAULT NULL,
  decision ENUM('pending','approved','rejected','skipped','delegated') NOT NULL DEFAULT 'pending',
  acted_by INT UNSIGNED DEFAULT NULL,
  acted_at TIMESTAMP NULL DEFAULT NULL,
  comment VARCHAR(500) DEFAULT NULL,
  activated_at TIMESTAMP NULL DEFAULT NULL,
  is_escalation TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_ars_request (request_id),
  KEY idx_ars_approver (approver_user_id, decision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only audit of every action taken on a request.
CREATE TABLE IF NOT EXISTS approval_step_actions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id INT UNSIGNED NOT NULL,
  step_id INT UNSIGNED DEFAULT NULL,
  action ENUM('raise','approve','reject','delegate','escalate','auto_approve','cancel') NOT NULL,
  actor_id INT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(190) DEFAULT NULL,
  from_user_id INT UNSIGNED DEFAULT NULL,
  to_user_id INT UNSIGNED DEFAULT NULL,
  comment VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_asa_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Standing delegation of approval authority from one user to another.
CREATE TABLE IF NOT EXISTS approval_delegations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  from_user_id INT UNSIGNED NOT NULL,
  to_user_id INT UNSIGNED NOT NULL,
  reason VARCHAR(300) DEFAULT NULL,
  starts_at TIMESTAMP NULL DEFAULT NULL,
  ends_at TIMESTAMP NULL DEFAULT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_adel_tenant (tenant_id),
  KEY idx_adel_from (tenant_id, from_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-19-add-marketing-social.sql
-- =============================================================
-- Migration: Marketing > Social Campaigns
-- Run this in phpMyAdmin (Hostinger) after the base schema and the
-- workspace modules migration.
-- Safe to run once. Uses IF NOT EXISTS where possible.
--
-- Covers three things the Social screen needs:
--   1. Connected accounts  -> social_accounts
--      Each platform can hold MANY accounts. `type` distinguishes a
--      brand/company page from an individual employee account. For
--      employee accounts `owner_name`/`owner_user_id` identify who it
--      belongs to.
--   2. Social posts         -> social_posts
--      One row per campaign/post created from the Create wizard.
--      Content, optional image, target brand and status live here.
--   3. Post -> account fan-out -> social_post_accounts
--      Which specific connected accounts a post is published to.
-- =============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -------------------------------------------------------------
-- Table: social_accounts
-- A connected social handle. `platform` matches the app's platform ids
-- (linkedin, instagram, x, facebook, youtube, threads, tiktok, pinterest).
-- `type` = 'company' for a brand/company page, 'personal' for an
-- individual employee's own account.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `social_accounts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `platform` ENUM('linkedin','instagram','x','facebook','youtube','threads','tiktok','pinterest') NOT NULL,
  `type` ENUM('company','personal') NOT NULL DEFAULT 'company',
  `handle` VARCHAR(190) NOT NULL,
  `display_name` VARCHAR(190) DEFAULT NULL,
  `owner_name` VARCHAR(190) DEFAULT NULL,
  `owner_user_id` INT UNSIGNED DEFAULT NULL,
  `followers` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_connected` BOOLEAN NOT NULL DEFAULT TRUE,
  `connected_by` INT UNSIGNED DEFAULT NULL,
  `connected_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_social_accounts_platform` (`platform`),
  KEY `idx_social_accounts_type` (`type`),
  KEY `idx_social_accounts_owner` (`owner_user_id`),
  CONSTRAINT `fk_social_accounts_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_social_accounts_connected_by` FOREIGN KEY (`connected_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: social_posts
-- One row per post created in the Create wizard. `image_url` holds an
-- optional uploaded image. `brand` is the chosen brand from step 1.
-- `scheduled_at` / `published_at` are set when the post is scheduled or
-- goes live.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `social_posts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `content` TEXT DEFAULT NULL,
  `image_url` VARCHAR(500) DEFAULT NULL,
  `brand` VARCHAR(190) DEFAULT NULL,
  `status` ENUM('Draft','Scheduled','Publishing','Published','Failed') NOT NULL DEFAULT 'Draft',
  `folder` VARCHAR(120) NOT NULL DEFAULT 'Unclassified',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `scheduled_at` DATETIME DEFAULT NULL,
  `published_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_social_posts_status` (`status`),
  KEY `idx_social_posts_created_by` (`created_by`),
  CONSTRAINT `fk_social_posts_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: social_post_accounts
-- Fan-out: which connected accounts a post targets. Deleting a post or
-- an account removes the link rows. `platform` is denormalised so the
-- target set survives even if the account row is later removed.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `social_post_accounts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `post_id` INT UNSIGNED NOT NULL,
  `account_id` INT UNSIGNED DEFAULT NULL,
  `platform` ENUM('linkedin','instagram','x','facebook','youtube','threads','tiktok','pinterest') NOT NULL,
  `publish_status` ENUM('Pending','Publishing','Published','Failed') NOT NULL DEFAULT 'Pending',
  `external_post_id` VARCHAR(190) DEFAULT NULL,
  `error_message` VARCHAR(500) DEFAULT NULL,
  `published_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_spa_post_platform_account` (`post_id`, `platform`, `account_id`),
  KEY `idx_spa_account` (`account_id`),
  CONSTRAINT `fk_spa_post` FOREIGN KEY (`post_id`) REFERENCES `social_posts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_spa_account` FOREIGN KEY (`account_id`) REFERENCES `social_accounts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- -------------------------------------------------------------
-- Features (permissions) attached to the marketing module.
-- Mirrors how the recruitment / messaging migrations register features.
-- -------------------------------------------------------------
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT id, 'Social Campaigns', 'marketing.social.view', 'View social campaigns and posts', 60
FROM `modules` WHERE `slug` = 'marketing'
  AND NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'marketing.social.view');

INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT id, 'Create Social Posts', 'marketing.social.create', 'Create and publish social posts', 61
FROM `modules` WHERE `slug` = 'marketing'
  AND NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'marketing.social.create');

INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT id, 'Connect Social Accounts', 'marketing.social.connect_accounts', 'Connect company pages and employee accounts', 62
FROM `modules` WHERE `slug` = 'marketing'
  AND NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'marketing.social.connect_accounts');

-- -------------------------------------------------------------
-- Optional seed data mirroring the app's demo state.
-- Comment out if you don't want demo rows.
-- -------------------------------------------------------------
INSERT INTO `social_accounts` (`platform`, `type`, `handle`, `owner_name`, `followers`, `connected_at`) VALUES
  ('linkedin',  'company',  '@muenot',          NULL,           12400, '2026-08-02 00:00:00'),
  ('instagram', 'company',  '@muenot.official', NULL,            8600, '2026-08-10 00:00:00'),
  ('x',         'company',  '@muenot',          NULL,            5200, '2026-08-14 00:00:00'),
  ('linkedin',  'personal', '@priya.sharma',    'Priya Sharma',  3200, '2026-08-20 00:00:00');



-- FILE: 2026-09-20-add-background-job-queue.sql
-- SPEC 42 â€” durable background job queue. Job types are validated in code;
-- this table stores data and operational state, never executable commands.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_background_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_type` VARCHAR(80) NOT NULL,
  `tenant_id` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `payload` JSON NOT NULL,
  `status` ENUM('queued','running','completed','failed','dead_letter','cancelled') NOT NULL DEFAULT 'queued',
  `priority` TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts` TINYINT UNSIGNED NOT NULL DEFAULT 3,
  `backoff_seconds` SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  `timeout_seconds` SMALLINT UNSIGNED NOT NULL DEFAULT 300,
  `concurrency_key` VARCHAR(160) NULL,
  `concurrency_limit` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `idempotency_key` VARCHAR(160) NOT NULL,
  `available_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `locked_at` DATETIME NULL,
  `worker_id` VARCHAR(120) NULL,
  `cancel_requested` TINYINT(1) NOT NULL DEFAULT 0,
  `started_at` DATETIME NULL,
  `completed_at` DATETIME NULL,
  `result` JSON NULL,
  `error_message` TEXT NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_background_job_idempotency` (`job_type`, `tenant_id`, `idempotency_key`),
  KEY `idx_background_job_ready` (`status`, `available_at`, `priority`),
  KEY `idx_background_job_tenant` (`tenant_id`, `status`, `created_at`),
  KEY `idx_background_job_concurrency` (`concurrency_key`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_background_job_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` BIGINT UNSIGNED NOT NULL,
  `event_type` VARCHAR(40) NOT NULL,
  `detail` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_background_job_event` (`job_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-20-add-cron-job-configuration.sql
-- ============================================================================
-- SPEC 40 â€” Safe platform scheduled-job configuration.
-- The endpoint is always selected from the reviewed application allow-list;
-- this schema intentionally has no command or user-supplied URL column.
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_cron_jobs` (
  `job_key` VARCHAR(100) NOT NULL,
  `cron_expression` VARCHAR(120) NOT NULL,
  `timezone` VARCHAR(80) NOT NULL DEFAULT 'UTC',
  `start_at` DATETIME NULL,
  `end_at` DATETIME NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `retry_limit` TINYINT UNSIGNED NOT NULL DEFAULT 2,
  `timeout_seconds` SMALLINT UNSIGNED NOT NULL DEFAULT 300,
  `concurrency_limit` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `notify_on_failure` TINYINT(1) NOT NULL DEFAULT 1,
  `notification_emails` VARCHAR(1000) NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`job_key`),
  KEY `idx_platform_cron_enabled` (`enabled`),
  KEY `idx_platform_cron_schedule` (`cron_expression`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_cron_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_key` VARCHAR(100) NOT NULL,
  `scheduled_for` DATETIME NOT NULL,
  `status` ENUM('running','succeeded','failed','skipped') NOT NULL DEFAULT 'running',
  `attempt` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `started_at` DATETIME NOT NULL,
  `finished_at` DATETIME NULL,
  `duration_ms` INT UNSIGNED NULL,
  `error_message` TEXT NULL,
  `trigger_source` ENUM('scheduler','manual') NOT NULL DEFAULT 'scheduler',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_platform_cron_slot` (`job_key`, `scheduled_for`),
  KEY `idx_platform_cron_runs_status` (`status`, `started_at`),
  KEY `idx_platform_cron_runs_job` (`job_key`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `platform_cron_audit` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_key` VARCHAR(100) NOT NULL,
  `action` VARCHAR(40) NOT NULL,
  `detail` JSON NULL,
  `actor_user_id` BIGINT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_platform_cron_audit_job` (`job_key`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-20-add-job-idempotency.sql
-- Receipt is committed in the same InnoDB transaction as business effects.
CREATE TABLE IF NOT EXISTS platform_job_receipts (
  operation_key CHAR(64) PRIMARY KEY,
  request_hash CHAR(64) NOT NULL,
  execution_id CHAR(36) NOT NULL,
  result JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_job_execution (execution_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-20-add-job-monitoring.sql
-- SPEC 43: preserve unknown for historical jobs; new producers record source.
-- Idempotent, including when the runtime schema initializer ran first.
SET @monitor_column_exists = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema=DATABASE() AND table_name='platform_background_jobs' AND column_name='trigger_source');
SET @monitor_sql = IF(@monitor_column_exists=0,
  'ALTER TABLE platform_background_jobs ADD COLUMN trigger_source VARCHAR(30) NOT NULL DEFAULT ''unknown''',
  'SELECT 1');
PREPARE monitor_statement FROM @monitor_sql;
EXECUTE monitor_statement;
DEALLOCATE PREPARE monitor_statement;



-- FILE: 2026-09-20-add-tenant-settings.sql
-- ============================================================================
-- SPEC 39 â€” Canonical tenant configuration (additive and idempotent)
--
-- `company_settings` remains an inherited legacy/platform baseline. Runtime
-- writes use `tenant_settings`, so every customer can override the same key
-- without changing another tenant's configuration.
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `tenant_settings` (
  `tenant_id` INT UNSIGNED NOT NULL,
  `skey` VARCHAR(160) NOT NULL,
  `svalue` LONGTEXT DEFAULT NULL,
  `value_type` VARCHAR(32) NOT NULL DEFAULT 'text',
  `is_secret` TINYINT(1) NOT NULL DEFAULT 0,
  `source` ENUM('override','migrated') NOT NULL DEFAULT 'override',
  `updated_by` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`, `skey`),
  KEY `idx_tenant_settings_key` (`skey`),
  CONSTRAINT `fk_tenant_settings_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `tenant_settings_audit` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `setting_key` VARCHAR(160) NOT NULL,
  `action` ENUM('set','clear') NOT NULL,
  `detail` JSON DEFAULT NULL,
  `actor_user_id` BIGINT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tenant_settings_audit_tenant` (`tenant_id`, `created_at`),
  CONSTRAINT `fk_tenant_settings_audit_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-20-add-whatsapp-messaging.sql
-- =============================================================
-- Migration: WhatsApp Cloud API messaging (inbox + conversations)
-- Run this in phpMyAdmin (Hostinger) after the base schema and the
-- marketing social migration.
-- Safe to run once. Uses IF NOT EXISTS throughout, so it is idempotent.
--
-- These tables are SEPARATE from the internal employee messaging tables
-- (`conversations`, `messages`, `conversation_participants`) which power the
-- ERP's internal chat and MUST remain untouched. WhatsApp uses its own
-- namespace so the two systems never collide.
--
-- Covers:
--   1. marketing_whatsapp_contacts       -> one row per external WhatsApp user
--   2. marketing_whatsapp_conversations  -> one thread per contact + number
--   3. marketing_whatsapp_messages       -> every inbound/outbound message
--   4. marketing_whatsapp_webhook_events -> lightweight webhook audit log
--
-- The existing `marketing_whatsapp_integration` table (created at runtime by
-- lib/whatsapp.ts ensureWhatsAppTable) is intentionally NOT redefined here so
-- existing deployments keep their stored, encrypted credentials.
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Table: marketing_whatsapp_contacts
-- An external person we exchange WhatsApp messages with. `phone_number` is the
-- E.164 digits without a leading +. `lead_id` optionally links to an existing
-- CRM lead so the conversation can show the linked contact â€” never duplicated.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_contacts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `phone_number` VARCHAR(32) NOT NULL,
  `profile_name` VARCHAR(191) DEFAULT NULL,
  `wa_contact_id` VARCHAR(64) DEFAULT NULL,
  `lead_id` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_contact_phone` (`phone_number`),
  KEY `idx_wa_contact_lead` (`lead_id`),
  CONSTRAINT `fk_wa_contact_lead` FOREIGN KEY (`lead_id`) REFERENCES `sales_leads` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: marketing_whatsapp_conversations
-- One conversation thread per (contact, business phone number). `status` marks
-- open/closed. `last_customer_message_at` drives the 24-hour customer service
-- window used to decide whether free text is allowed.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_conversations` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `contact_id` INT UNSIGNED NOT NULL,
  `phone_number_id` VARCHAR(191) NOT NULL,
  `waba_id` VARCHAR(191) DEFAULT NULL,
  `status` ENUM('open','closed') NOT NULL DEFAULT 'open',
  `last_message_at` DATETIME DEFAULT NULL,
  `last_customer_message_at` DATETIME DEFAULT NULL,
  `unread_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_message_preview` VARCHAR(500) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_convo_contact_number` (`contact_id`, `phone_number_id`),
  KEY `idx_wa_convo_last_message` (`last_message_at`),
  KEY `idx_wa_convo_status` (`status`),
  CONSTRAINT `fk_wa_convo_contact` FOREIGN KEY (`contact_id`) REFERENCES `marketing_whatsapp_contacts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: marketing_whatsapp_messages
-- Every message in both directions. `wamid` is Meta's message id and is UNIQUE
-- so retried webhooks never create duplicates. `status` follows the Cloud API
-- lifecycle. Media is referenced by Meta media id + metadata only â€” never the
-- blob itself (see requirement 16).
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_messages` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` INT UNSIGNED NOT NULL,
  `wamid` VARCHAR(191) DEFAULT NULL,
  `direction` ENUM('inbound','outbound') NOT NULL,
  `message_type` VARCHAR(32) NOT NULL DEFAULT 'text',
  `message_body` TEXT DEFAULT NULL,
  `media_id` VARCHAR(191) DEFAULT NULL,
  `media_mime_type` VARCHAR(128) DEFAULT NULL,
  `media_filename` VARCHAR(255) DEFAULT NULL,
  `media_url` VARCHAR(500) DEFAULT NULL,
  `sender_phone` VARCHAR(32) DEFAULT NULL,
  `recipient_phone` VARCHAR(32) DEFAULT NULL,
  `status` ENUM('received','queued','sent','delivered','read','failed') NOT NULL DEFAULT 'queued',
  `status_rank` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `meta_timestamp` DATETIME DEFAULT NULL,
  `error_code` VARCHAR(32) DEFAULT NULL,
  `error_message` VARCHAR(500) DEFAULT NULL,
  `sent_at` DATETIME DEFAULT NULL,
  `delivered_at` DATETIME DEFAULT NULL,
  `read_at` DATETIME DEFAULT NULL,
  `sent_by_user_id` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_message_wamid` (`wamid`),
  KEY `idx_wa_message_conversation` (`conversation_id`),
  KEY `idx_wa_message_direction` (`direction`),
  KEY `idx_wa_message_status` (`status`),
  KEY `idx_wa_message_created` (`created_at`),
  CONSTRAINT `fk_wa_message_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `marketing_whatsapp_conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wa_message_user` FOREIGN KEY (`sent_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: marketing_whatsapp_webhook_events
-- Lightweight audit log for debugging Meta webhook retries. Stores metadata
-- ONLY â€” never tokens, secrets, verify tokens or PINs. `dedup_key` makes event
-- processing idempotent for status updates that share a wamid.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_webhook_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_type` VARCHAR(48) NOT NULL,
  `wamid` VARCHAR(191) DEFAULT NULL,
  `phone_number_id` VARCHAR(191) DEFAULT NULL,
  `dedup_key` VARCHAR(255) DEFAULT NULL,
  `processing_status` ENUM('received','processed','skipped','error') NOT NULL DEFAULT 'received',
  `error` VARCHAR(500) DEFAULT NULL,
  `received_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_event_dedup` (`dedup_key`),
  KEY `idx_wa_event_wamid` (`wamid`),
  KEY `idx_wa_event_type` (`event_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-20-spec46-workflow-engine.sql
-- SPEC 46: additive workflow tables. Existing domain/approval tables are unchanged.
CREATE TABLE IF NOT EXISTS erp_workflows (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, name VARCHAR(120) NOT NULL, definition JSON NOT NULL, enabled BOOLEAN NOT NULL DEFAULT 1, created_by INT UNSIGNED NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY tenant_idx(tenant_id,id)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS erp_workflow_runs (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, workflow_id BIGINT UNSIGNED NOT NULL, snapshot JSON NOT NULL, record_id BIGINT UNSIGNED NOT NULL, request_key VARCHAR(64) NOT NULL, request_hash CHAR(64) NOT NULL, requested_by INT UNSIGNED NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'queued', cursor INT NOT NULL DEFAULT 0, available_at DATETIME NOT NULL, error_code VARCHAR(80) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY request_idx(tenant_id,workflow_id,request_key), KEY due_idx(status,available_at), KEY tenant_idx(tenant_id,id)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS erp_workflow_events (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, run_id BIGINT UNSIGNED NOT NULL, step INT NOT NULL, event_type VARCHAR(40) NOT NULL, actor_id INT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY run_idx(tenant_id,run_id,id)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS erp_workflow_notices (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, run_id BIGINT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, message VARCHAR(1000) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY inbox_idx(tenant_id,user_id,id)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS erp_workflow_tasks (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, title VARCHAR(255) NOT NULL, description TEXT NOT NULL, priority VARCHAR(16) NOT NULL DEFAULT 'Medium', status VARCHAR(24) NOT NULL DEFAULT 'Open', assigned_to INT UNSIGNED NOT NULL, source_run_id BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY tenant_idx(tenant_id,id)) ENGINE=InnoDB;



-- FILE: 2026-09-20-spec48-event-bus.sql
-- SPEC 48: additive central event bus / durable subscriber deliveries.
CREATE TABLE IF NOT EXISTS erp_business_events (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, event_type VARCHAR(60) NOT NULL, schema_version INT NOT NULL DEFAULT 1, fanout_complete BOOLEAN NOT NULL DEFAULT 0, entity_id BIGINT UNSIGNED NOT NULL, event_key VARCHAR(191) NOT NULL, request_hash CHAR(64) NOT NULL, actor_id INT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY event_identity(tenant_id,event_type,event_key), KEY tenant_idx(tenant_id,id)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS erp_event_subscriptions (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, name VARCHAR(120) NOT NULL, event_type VARCHAR(60) NOT NULL, config JSON NOT NULL, created_by INT UNSIGNED NOT NULL, enabled BOOLEAN NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY route_idx(tenant_id,event_type,enabled)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS erp_event_deliveries (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, event_id BIGINT UNSIGNED NOT NULL, subscriber_id BIGINT UNSIGNED NOT NULL, config JSON NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'queued', attempts INT NOT NULL DEFAULT 0, available_at DATETIME NOT NULL, result_id BIGINT UNSIGNED NULL, error_code VARCHAR(80) NULL, completed_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY delivery_identity(event_id,subscriber_id), KEY due_idx(status,available_at), KEY tenant_idx(tenant_id,event_id)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS erp_event_delivery_log (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, delivery_id BIGINT UNSIGNED NOT NULL, action VARCHAR(40) NOT NULL, attempt INT NOT NULL, actor_id INT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY delivery_idx(tenant_id,delivery_id,id)) ENGINE=InnoDB;



-- FILE: 2026-09-21-add-employee-events-and-archive.sql
-- Employee lifecycle: unified audit + timeline events, import history, and
-- soft-archive support for hr_employees.
--
-- Safe to run multiple times. MariaDB syntax (ADD COLUMN IF NOT EXISTS) is used
-- to match the existing migrations in this project.

-- ---------------------------------------------------------------------------
-- Unified event log (drives both the Audit trail and the activity Timeline).
-- Intentionally has NO foreign key on employee_id: audit rows must OUTLIVE the
-- employee record so a hard delete still leaves a permanent trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `hr_employee_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` INT UNSIGNED NOT NULL,
  `employee_ref` VARCHAR(50) DEFAULT NULL,
  `employee_name` VARCHAR(150) DEFAULT NULL,
  `event_type` VARCHAR(60) NOT NULL,
  `summary` VARCHAR(255) NOT NULL,
  `changes` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `actor_name` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_hr_event_employee` (`employee_id`, `created_at`),
  KEY `idx_hr_event_type` (`event_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Import history â€” one row per bulk import run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `hr_employee_imports` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `file_name` VARCHAR(255) DEFAULT NULL,
  `total_rows` INT UNSIGNED NOT NULL DEFAULT 0,
  `imported` INT UNSIGNED NOT NULL DEFAULT 0,
  `failed` INT UNSIGNED NOT NULL DEFAULT 0,
  `skipped` INT UNSIGNED NOT NULL DEFAULT 0,
  `errors` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `actor_name` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_hr_import_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Soft-archive support on the employee master.
-- ---------------------------------------------------------------------------
ALTER TABLE `hr_employees`
  ADD COLUMN IF NOT EXISTS `archived_at` DATETIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `archived_by` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `status_changed_at` DATETIME DEFAULT NULL;

-- New feature slugs (resolve onto the existing hr.employees permission module).
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Employee Audit Trail', 'hr.view_employee_audit', 'View employee change history and timeline', 14
FROM modules WHERE slug = 'hr';



-- FILE: 2026-09-21-add-whatsapp-shared-inbox.sql
-- =============================================================
-- Migration: WhatsApp Shared Inbox (multi-agent) layer
-- Run this in phpMyAdmin (Hostinger) AFTER
-- 2026-09-20-add-whatsapp-messaging.sql.
--
-- Adds the collaboration layer on top of the existing WhatsApp messaging
-- tables so multiple ERP agents can work the SAME WhatsApp Business number
-- (+91 63778 09826) from one Shared Inbox:
--   * conversation assignment (individual agent + team)
--   * conversation priority
--   * a "pending" conversation status (open / pending / closed)
--   * contact notes + tags
--   * an assignment audit trail
--
-- Nothing here touches the coexistence connection or the WhatsApp Business
-- App on the same number. It is purely ERP-side collaboration metadata.
--
-- The runtime helper ensureWhatsAppMessagingTables() in lib/whatsapp-store.ts
-- self-heals these same columns/tables, so a deployment that has not run this
-- SQL yet still works. This file is the canonical, reviewable definition.
--
-- IDEMPOTENT: every statement below uses IF NOT EXISTS / IF EXISTS guards and
-- is split into its own ALTER, so this file can be re-imported safely even if
-- the runtime self-heal (or a previous partial import) already added some of
-- these columns, keys, or constraints. This avoids the phpMyAdmin
-- "#1060 - Duplicate column name" abort on re-run. Requires MariaDB 10.x
-- (which Hostinger uses); the IF NOT EXISTS clauses are MariaDB extensions.
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Conversations: assignment + priority + pending status
-- -------------------------------------------------------------
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `assigned_agent_id` INT UNSIGNED DEFAULT NULL AFTER `waba_id`;

ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `assigned_team` VARCHAR(64) DEFAULT NULL AFTER `assigned_agent_id`;

ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `priority` ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal' AFTER `assigned_team`;

ALTER TABLE `marketing_whatsapp_conversations`
  MODIFY COLUMN `status` ENUM('open','pending','closed') NOT NULL DEFAULT 'open';

ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_wa_convo_agent` (`assigned_agent_id`);

ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_wa_convo_team` (`assigned_team`);

ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_wa_convo_priority` (`priority`);

-- Re-create the FK defensively: drop it if a previous run/self-heal added it,
-- then add it back so the definition stays canonical.
ALTER TABLE `marketing_whatsapp_conversations`
  DROP FOREIGN KEY IF EXISTS `fk_wa_convo_agent`;

ALTER TABLE `marketing_whatsapp_conversations`
  ADD CONSTRAINT `fk_wa_convo_agent` FOREIGN KEY (`assigned_agent_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL;

-- -------------------------------------------------------------
-- Contacts: agent-facing notes + tags
-- -------------------------------------------------------------
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `notes` TEXT DEFAULT NULL AFTER `lead_id`;

ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `tags` VARCHAR(500) DEFAULT NULL AFTER `notes`;

-- -------------------------------------------------------------
-- Table: marketing_whatsapp_assignments
-- Audit trail of every assign / reassign / unassign action so admins can see
-- who routed a conversation and when. Never stores secrets.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_assignments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` INT UNSIGNED NOT NULL,
  `action` ENUM('assign','reassign','unassign') NOT NULL,
  `assigned_agent_id` INT UNSIGNED DEFAULT NULL,
  `assigned_team` VARCHAR(64) DEFAULT NULL,
  `assigned_by` INT UNSIGNED DEFAULT NULL,
  `note` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_assign_convo` (`conversation_id`),
  KEY `idx_wa_assign_agent` (`assigned_agent_id`),
  CONSTRAINT `fk_wa_assign_convo` FOREIGN KEY (`conversation_id`)
    REFERENCES `marketing_whatsapp_conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wa_assign_agent` FOREIGN KEY (`assigned_agent_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_wa_assign_by` FOREIGN KEY (`assigned_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-21-shopkeeper-mobile-platform.sql
-- Phase 1: additive Shopkeeper/mobile foundation. Existing tenants default to ENTERPRISE.
-- The runtime service can create this column first, so keep the migration safe
-- when it is applied afterwards on a live database.
DELIMITER $$
DROP PROCEDURE IF EXISTS __shopkeeper_add_tenant_type $$
CREATE PROCEDURE __shopkeeper_add_tenant_type()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='tenants' AND column_name='tenant_type') THEN
    ALTER TABLE tenants ADD COLUMN tenant_type VARCHAR(20) NOT NULL DEFAULT 'ENTERPRISE' AFTER status;
  END IF;
END $$
CALL __shopkeeper_add_tenant_type() $$
DROP PROCEDURE __shopkeeper_add_tenant_type $$
DELIMITER ;

CREATE TABLE IF NOT EXISTS shopkeeper_profiles (
  tenant_id INT UNSIGNED NOT NULL, shop_name VARCHAR(150) NOT NULL, owner_name VARCHAR(150) NULL,
  business_category VARCHAR(120) NULL, email VARCHAR(190) NULL, phone VARCHAR(40) NULL, address VARCHAR(500) NULL,
  city VARCHAR(120) NULL, state VARCHAR(120) NULL, pin_code VARCHAR(20) NULL, country VARCHAR(120) NULL,
  logo_url VARCHAR(500) NULL, business_hours JSON NULL, timezone VARCHAR(80) NULL, currency VARCHAR(12) NULL,
  gstin VARCHAR(32) NULL, website VARCHAR(255) NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id), CONSTRAINT fk_shopkeeper_profile_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mobile_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, session_id VARCHAR(64) NOT NULL, tenant_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL, refresh_token_hash CHAR(64) NOT NULL, device_name VARCHAR(120) NULL, platform VARCHAR(32) NULL,
  push_token_hash CHAR(64) NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL, revoked_at DATETIME NULL, revoked_reason VARCHAR(60) NULL, PRIMARY KEY(id),
  UNIQUE KEY uq_mobile_session(session_id), UNIQUE KEY uq_mobile_refresh(refresh_token_hash), KEY idx_mobile_sessions_user(user_id,tenant_id),
  CONSTRAINT fk_mobile_session_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_session_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mobile_device_registrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
  mobile_session_id VARCHAR(64) NOT NULL, provider VARCHAR(20) NOT NULL DEFAULT 'fcm', token_hash CHAR(64) NOT NULL, token_encrypted TEXT NOT NULL,
  device_name VARCHAR(120) NULL, platform VARCHAR(32) NULL, enabled TINYINT(1) NOT NULL DEFAULT 1, last_seen_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_mobile_device_token(tenant_id,token_hash), KEY idx_mobile_device_user(tenant_id,user_id),
  CONSTRAINT fk_mobile_device_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mobile_api_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
  session_id VARCHAR(64) NULL, action VARCHAR(80) NOT NULL, method VARCHAR(12) NULL, path VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(id),
  KEY idx_mobile_audit_tenant(tenant_id,created_at), KEY idx_mobile_audit_user(user_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-21-spec49-notification-engine.sql
-- SPEC 49: centralized notification queue. Existing bell schema remains unchanged.
CREATE TABLE IF NOT EXISTS notification_templates (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, name VARCHAR(120) NOT NULL, title VARCHAR(255) NOT NULL, body TEXT NOT NULL, created_by INT UNSIGNED NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY tenant_idx(tenant_id,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notification_preferences (tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, channel VARCHAR(20) NOT NULL, enabled BOOLEAN NOT NULL, destination VARCHAR(512) NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY(tenant_id,user_id,channel)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notification_deliveries (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, channel VARCHAR(20) NOT NULL, request_key VARCHAR(191) NOT NULL, request_hash CHAR(64) NOT NULL, title VARCHAR(255) NOT NULL, body TEXT NOT NULL, link VARCHAR(255) NULL, source_context JSON NULL, priority INT NOT NULL DEFAULT 5, available_at DATETIME NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'queued', attempts INT NOT NULL DEFAULT 0, lease CHAR(36) NULL, started_at DATETIME NULL, result_id VARCHAR(191) NULL, error_code VARCHAR(80) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY identity_idx(tenant_id,channel,request_key), KEY due_idx(status,available_at,priority), KEY tenant_idx(tenant_id,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notification_delivery_log (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id INT UNSIGNED NOT NULL, delivery_id BIGINT UNSIGNED NOT NULL, attempt INT NOT NULL, status VARCHAR(20) NOT NULL, actor_id INT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY delivery_idx(tenant_id,delivery_id,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-21-spec50-email-engine.sql
-- SPEC 50: centralized, tenant-scoped email engine. Transport secrets remain in
-- the existing encrypted environment-variable store; this migration stores no secrets.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS tenant_email_senders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL,
  module VARCHAR(30) NOT NULL, from_name VARCHAR(120) NULL, from_address VARCHAR(190) NULL,
  reply_to VARCHAR(190) NULL, transport_department VARCHAR(30) NOT NULL DEFAULT 'sales', enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tenant_email_sender (tenant_id,module), KEY idx_tenant_email_sender (tenant_id,enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tenant_email_templates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL, module VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL, template_key VARCHAR(120) NULL, subject VARCHAR(255) NOT NULL, html MEDIUMTEXT NOT NULL,
  variables_json JSON NULL, status VARCHAR(20) NOT NULL DEFAULT 'draft', version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tenant_email_template_key (tenant_id,module,template_key), KEY idx_tenant_email_templates (tenant_id,module,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tenant_email_messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL, module VARCHAR(30) NOT NULL,
  template_id BIGINT UNSIGNED NULL, sender_id BIGINT UNSIGNED NULL, to_email VARCHAR(190) NOT NULL, to_name VARCHAR(190) NULL,
  subject VARCHAR(255) NOT NULL, html MEDIUMTEXT NOT NULL, thread_key VARCHAR(160) NOT NULL, in_reply_to_message_id BIGINT UNSIGNED NULL,
  message_id VARCHAR(255) NULL, provider_thread_id VARCHAR(190) NULL, references_header TEXT NULL, attachments_json JSON NULL,
  tracking_token VARCHAR(64) NULL, tracking_consent BOOLEAN NOT NULL DEFAULT FALSE,
  status ENUM('queued','sending','accepted','delivered','bounced','failed','cancelled') NOT NULL DEFAULT 'queued', attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  job_id BIGINT UNSIGNED NULL, provider_message_id VARCHAR(255) NULL, last_error VARCHAR(1000) NULL,
  sent_by BIGINT UNSIGNED NULL, accepted_at DATETIME NULL, delivered_at DATETIME NULL, opened_at DATETIME NULL, open_count INT UNSIGNED NOT NULL DEFAULT 0,
  clicked_at DATETIME NULL, click_count INT UNSIGNED NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tenant_email_tracking (tracking_token), KEY idx_tenant_email_messages (tenant_id,status,created_at), KEY idx_tenant_email_thread (tenant_id,thread_key,created_at), KEY idx_tenant_email_job (job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tenant_email_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT UNSIGNED NOT NULL, message_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(30) NOT NULL, detail JSON NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tenant_email_events (tenant_id,message_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-21-whatsapp-cloud-registration.sql
-- Additive only: preserves all existing WhatsApp connections and credentials.
CREATE TABLE IF NOT EXISTS marketing_whatsapp_registration (tenant_id INT UNSIGNED NOT NULL, connection_id INT UNSIGNED NOT NULL, pin_encrypted TEXT NULL, cloud_api_registered BOOLEAN NOT NULL DEFAULT FALSE, registration_status VARCHAR(40) NOT NULL DEFAULT 'pending', registration_error_code VARCHAR(40) NULL, registration_error_message VARCHAR(500) NULL, registration_checked_at DATETIME NULL, PRIMARY KEY (tenant_id,connection_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_whatsapp_signup_progress (tenant_id INT UNSIGNED NOT NULL, signup_id INT UNSIGNED NOT NULL, exchange_status VARCHAR(32) NOT NULL, token_encrypted TEXT NULL, connection_id INT UNSIGNED NULL, PRIMARY KEY (tenant_id,signup_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-22-add-whatsapp-platform.sql
-- =============================================================
-- Migration: WhatsApp multi-agent platform (AiSensy-style)
-- Run in phpMyAdmin (Hostinger) AFTER
-- 2026-09-21-add-whatsapp-shared-inbox.sql.
--
-- Adds the full platform layer on top of the existing shared-inbox tables so
-- ONE WhatsApp Business number (+91 63778 09826) can be worked by MANY ERP
-- agents across MANY departments, with routing, templates, campaigns,
-- audiences, automations, internal notes, media metadata and analytics.
--
-- Nothing here touches coexistence, the WhatsApp Business App, or calls
-- /register. It is purely ERP-side collaboration + marketing metadata.
--
-- IDEMPOTENT: every statement uses IF NOT EXISTS / IF EXISTS guards (MariaDB
-- 10.x extensions, which Hostinger runs). The runtime self-heal in
-- lib/whatsapp-platform.ts mirrors these tables/columns so a deployment that
-- has not imported this SQL yet still works. This file is the canonical,
-- reviewable definition.
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Departments / teams (WhatsApp-specific desks)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_departments` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `slug` VARCHAR(120) NOT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `manager_user_id` INT UNSIGNED DEFAULT NULL,
  -- department | round_robin | least_active | least_assigned | manual
  `routing_method` VARCHAR(32) NOT NULL DEFAULT 'round_robin',
  -- JSON: { "0": {"open":"09:00","close":"18:00","enabled":true}, ... } (0=Sun)
  `working_hours` TEXT DEFAULT NULL,
  `auto_assign` TINYINT(1) NOT NULL DEFAULT 1,
  -- newline / comma separated keywords that route an inbound message here
  `keywords` VARCHAR(1000) DEFAULT NULL,
  `color` VARCHAR(16) DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_dept_slug` (`slug`),
  KEY `idx_wa_dept_active` (`is_active`),
  CONSTRAINT `fk_wa_dept_manager` FOREIGN KEY (`manager_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the default departments once (only when the table is empty).
INSERT INTO `marketing_whatsapp_departments` (`name`, `slug`, `description`, `routing_method`, `sort_order`)
SELECT * FROM (
  SELECT 'Sales' AS name, 'sales' AS slug, 'New business, quotations and lead follow-up' AS description, 'round_robin' AS routing_method, 1 AS sort_order UNION ALL
  SELECT 'Support', 'support', 'Customer support and issue resolution', 'round_robin', 2 UNION ALL
  SELECT 'Marketing', 'marketing', 'Campaigns, promotions and broadcasts', 'round_robin', 3 UNION ALL
  SELECT 'Accounts', 'accounts', 'Billing, payments and invoices', 'round_robin', 4 UNION ALL
  SELECT 'HR', 'hr', 'Recruitment and people operations', 'round_robin', 5 UNION ALL
  SELECT 'Operations', 'operations', 'Delivery and project operations', 'round_robin', 6 UNION ALL
  SELECT 'Admin', 'admin', 'Administrative and everything else', 'round_robin', 7
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM `marketing_whatsapp_departments`);

-- -------------------------------------------------------------
-- Department membership: which ERP users staff each department
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_department_agents` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `department_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `role` ENUM('agent','manager') NOT NULL DEFAULT 'agent',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_dept_agent` (`department_id`, `user_id`),
  KEY `idx_wa_dept_agent_user` (`user_id`),
  CONSTRAINT `fk_wa_deptagent_dept` FOREIGN KEY (`department_id`) REFERENCES `marketing_whatsapp_departments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wa_deptagent_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Per-user WhatsApp agent settings + granular capabilities
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_agent_settings` (
  `user_id` INT UNSIGNED NOT NULL,
  `is_agent` TINYINT(1) NOT NULL DEFAULT 0,
  `is_available` TINYINT(1) NOT NULL DEFAULT 1,
  `can_view_all` TINYINT(1) NOT NULL DEFAULT 0,
  `can_view_department` TINYINT(1) NOT NULL DEFAULT 1,
  `can_send` TINYINT(1) NOT NULL DEFAULT 1,
  `can_assign` TINYINT(1) NOT NULL DEFAULT 0,
  `can_reassign` TINYINT(1) NOT NULL DEFAULT 0,
  `can_close` TINYINT(1) NOT NULL DEFAULT 1,
  `can_send_templates` TINYINT(1) NOT NULL DEFAULT 1,
  `can_create_campaigns` TINYINT(1) NOT NULL DEFAULT 0,
  `can_view_analytics` TINYINT(1) NOT NULL DEFAULT 0,
  `can_manage_contacts` TINYINT(1) NOT NULL DEFAULT 0,
  `can_manage_automation` TINYINT(1) NOT NULL DEFAULT 0,
  `last_assigned_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  KEY `idx_wa_agent_is_agent` (`is_agent`),
  CONSTRAINT `fk_wa_agent_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Conversation platform columns: department, bot/human, SLA, source
-- -------------------------------------------------------------
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `department_id` INT UNSIGNED DEFAULT NULL AFTER `assigned_team`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `bot_enabled` TINYINT(1) NOT NULL DEFAULT 0 AFTER `priority`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `sla_due_at` DATETIME DEFAULT NULL AFTER `bot_enabled`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `first_response_at` DATETIME DEFAULT NULL AFTER `sla_due_at`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `closed_at` DATETIME DEFAULT NULL AFTER `first_response_at`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `closed_by` INT UNSIGNED DEFAULT NULL AFTER `closed_at`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `source` VARCHAR(64) DEFAULT NULL AFTER `closed_by`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_wa_convo_department` (`department_id`);
ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_wa_convo_sla` (`sla_due_at`);

-- -------------------------------------------------------------
-- Contact platform columns: geo + segmentation attributes
-- -------------------------------------------------------------
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `city` VARCHAR(120) DEFAULT NULL AFTER `tags`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `state` VARCHAR(120) DEFAULT NULL AFTER `city`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `country` VARCHAR(120) DEFAULT NULL AFTER `state`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `opted_in` TINYINT(1) NOT NULL DEFAULT 1 AFTER `country`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `custom_attributes` TEXT DEFAULT NULL AFTER `opted_in`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `last_interaction_at` DATETIME DEFAULT NULL AFTER `custom_attributes`;

-- -------------------------------------------------------------
-- Message note-to-self: whether an outbound msg came from a campaign
-- -------------------------------------------------------------
ALTER TABLE `marketing_whatsapp_messages`
  ADD COLUMN IF NOT EXISTS `campaign_id` INT UNSIGNED DEFAULT NULL AFTER `sent_by_user_id`;
ALTER TABLE `marketing_whatsapp_messages`
  ADD KEY IF NOT EXISTS `idx_wa_message_campaign` (`campaign_id`);

-- -------------------------------------------------------------
-- Internal notes (never sent to the customer)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_internal_notes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED DEFAULT NULL,
  `note` TEXT NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_note_convo` (`conversation_id`),
  CONSTRAINT `fk_wa_note_convo` FOREIGN KEY (`conversation_id`) REFERENCES `marketing_whatsapp_conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wa_note_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Department transfer audit trail (separate from agent assignments)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_transfers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` INT UNSIGNED NOT NULL,
  `from_department_id` INT UNSIGNED DEFAULT NULL,
  `to_department_id` INT UNSIGNED DEFAULT NULL,
  `from_agent_id` INT UNSIGNED DEFAULT NULL,
  `to_agent_id` INT UNSIGNED DEFAULT NULL,
  `transferred_by` INT UNSIGNED DEFAULT NULL,
  `reason` VARCHAR(500) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_transfer_convo` (`conversation_id`),
  CONSTRAINT `fk_wa_transfer_convo` FOREIGN KEY (`conversation_id`) REFERENCES `marketing_whatsapp_conversations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Media metadata (never stores the token or the blob itself)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_media` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `message_id` INT UNSIGNED DEFAULT NULL,
  `conversation_id` INT UNSIGNED DEFAULT NULL,
  `media_id` VARCHAR(191) NOT NULL,
  `mime_type` VARCHAR(128) DEFAULT NULL,
  `filename` VARCHAR(255) DEFAULT NULL,
  `file_size` INT UNSIGNED DEFAULT NULL,
  `sha256` VARCHAR(128) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_media_id` (`media_id`),
  KEY `idx_wa_media_message` (`message_id`),
  KEY `idx_wa_media_convo` (`conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Template cache (synced from Meta; only approved ones are sendable)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_templates` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `language` VARCHAR(16) NOT NULL,
  `category` VARCHAR(48) DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  `header_type` VARCHAR(32) DEFAULT NULL,
  `header_text` VARCHAR(1000) DEFAULT NULL,
  `body_text` TEXT DEFAULT NULL,
  `footer_text` VARCHAR(1000) DEFAULT NULL,
  `buttons_json` TEXT DEFAULT NULL,
  `variable_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `meta_id` VARCHAR(64) DEFAULT NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_template` (`name`, `language`),
  KEY `idx_wa_template_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Audiences (saved segmentation filters)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_audiences` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  -- JSON: { "match": "AND"|"OR", "conditions": [ { field, op, value }, ... ] }
  `filter_json` TEXT DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_wa_audience_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Campaigns (broadcasts / promotions)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_campaigns` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `type` VARCHAR(48) NOT NULL DEFAULT 'promotional',
  `department_id` INT UNSIGNED DEFAULT NULL,
  `audience_id` INT UNSIGNED DEFAULT NULL,
  -- snapshot of resolved audience filter at launch time
  `audience_filter_json` TEXT DEFAULT NULL,
  `template_name` VARCHAR(191) DEFAULT NULL,
  `template_language` VARCHAR(16) DEFAULT NULL,
  -- JSON array of variable mappings, e.g. ["{{name}}","10%","https://..."]
  `variables_json` TEXT DEFAULT NULL,
  `media_link` VARCHAR(1000) DEFAULT NULL,
  `header_media_id` VARCHAR(191) DEFAULT NULL,
  `scheduled_at` DATETIME DEFAULT NULL,
  `timezone` VARCHAR(64) DEFAULT 'Asia/Kolkata',
  `status` ENUM('draft','scheduled','running','paused','completed','failed','cancelled') NOT NULL DEFAULT 'draft',
  `total_recipients` INT UNSIGNED NOT NULL DEFAULT 0,
  `sent_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `delivered_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `read_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `failed_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `replied_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `launched_by` INT UNSIGNED DEFAULT NULL,
  `launched_at` DATETIME DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `last_error` VARCHAR(500) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_campaign_status` (`status`),
  KEY `idx_wa_campaign_scheduled` (`scheduled_at`),
  CONSTRAINT `fk_wa_campaign_dept` FOREIGN KEY (`department_id`) REFERENCES `marketing_whatsapp_departments` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_wa_campaign_audience` FOREIGN KEY (`audience_id`) REFERENCES `marketing_whatsapp_audiences` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_wa_campaign_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Campaign recipients (per-contact delivery tracking)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_campaign_recipients` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_id` INT UNSIGNED NOT NULL,
  `contact_id` INT UNSIGNED DEFAULT NULL,
  `phone_number` VARCHAR(32) NOT NULL,
  `variables_json` TEXT DEFAULT NULL,
  `wamid` VARCHAR(191) DEFAULT NULL,
  `status` ENUM('pending','sent','delivered','read','failed','replied') NOT NULL DEFAULT 'pending',
  `error_message` VARCHAR(500) DEFAULT NULL,
  `sent_at` DATETIME DEFAULT NULL,
  `delivered_at` DATETIME DEFAULT NULL,
  `read_at` DATETIME DEFAULT NULL,
  `replied_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wa_camp_recipient` (`campaign_id`, `phone_number`),
  KEY `idx_wa_camp_recipient_campaign` (`campaign_id`),
  KEY `idx_wa_camp_recipient_wamid` (`wamid`),
  KEY `idx_wa_camp_recipient_status` (`status`),
  CONSTRAINT `fk_wa_camp_recipient_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `marketing_whatsapp_campaigns` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Campaign events (append-only analytics stream)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_campaign_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_id` INT UNSIGNED NOT NULL,
  `recipient_id` BIGINT UNSIGNED DEFAULT NULL,
  `event_type` VARCHAR(32) NOT NULL,
  `detail` VARCHAR(500) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_camp_event_campaign` (`campaign_id`),
  KEY `idx_wa_camp_event_type` (`event_type`),
  CONSTRAINT `fk_wa_camp_event_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `marketing_whatsapp_campaigns` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Automations (rule-based; chatbot-ready)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_automations` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  -- keyword | new_conversation | no_reply | customer_requests_human | welcome
  `trigger_type` VARCHAR(48) NOT NULL,
  `trigger_config_json` TEXT DEFAULT NULL,
  -- send_template | send_text | assign_department | assign_agent | notify | create_task
  `action_type` VARCHAR(48) NOT NULL,
  `action_config_json` TEXT DEFAULT NULL,
  `department_id` INT UNSIGNED DEFAULT NULL,
  `priority` INT NOT NULL DEFAULT 0,
  `run_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_run_at` DATETIME DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wa_automation_active` (`is_active`),
  KEY `idx_wa_automation_trigger` (`trigger_type`),
  CONSTRAINT `fk_wa_automation_dept` FOREIGN KEY (`department_id`) REFERENCES `marketing_whatsapp_departments` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Notifications: link WhatsApp events into the ERP notifications table
-- when it exists (created elsewhere). No-op here beyond a helpful index.
-- -------------------------------------------------------------



-- FILE: 2026-09-22-shopkeeper-contact-fields.sql
-- =============================================================
-- Shopkeeper customer fields on the existing WhatsApp contact record
-- =============================================================
-- The Shopkeeper app's "Customer" IS the tenant's WhatsApp contact
-- (marketing_whatsapp_contacts), which is already tenant-scoped and already
-- carries notes/tags. Two fields are missing for the mobile Customer screens:
--
--   email       â€” the app collects it; there was nowhere to put it.
--   archived_at â€” shopkeeper_orders references contacts, so a hard DELETE would
--                 blank the customer off historical orders. The mobile DELETE
--                 therefore archives instead, and this column records that.
--
-- Written with an information_schema guard rather than
-- `ADD COLUMN IF NOT EXISTS`, which is MariaDB-only syntax that MySQL 8
-- rejects. This form is idempotent on both engines.
-- =============================================================

SET NAMES utf8mb4;

SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `marketing_whatsapp_contacts` ADD COLUMN `email` VARCHAR(190) NULL AFTER `profile_name`',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'marketing_whatsapp_contacts'
    AND column_name = 'email'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `marketing_whatsapp_contacts` ADD COLUMN `archived_at` DATETIME NULL DEFAULT NULL',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'marketing_whatsapp_contacts'
    AND column_name = 'archived_at'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX `idx_whatsapp_contacts_tenant_archived` ON `marketing_whatsapp_contacts` (`tenant_id`, `archived_at`)',
    'DO 0'
  )
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'marketing_whatsapp_contacts'
    AND index_name = 'idx_whatsapp_contacts_tenant_archived'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;



-- FILE: 2026-09-22-shopkeeper-notification-preferences.sql
-- =============================================================
-- Shopkeeper notification preferences
-- =============================================================
-- The mobile Settings screen has notification toggles, but shopkeeper_profiles
-- had nowhere to store them, so every toggle was lost on save. Stored as JSON
-- alongside business_hours rather than as a column per switch, because the set
-- of notification types will grow with the app.
--
-- information_schema guard rather than `ADD COLUMN IF NOT EXISTS`, which is
-- MariaDB-only syntax that MySQL 8 rejects. Idempotent on both engines.
-- =============================================================

SET NAMES utf8mb4;

SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `shopkeeper_profiles` ADD COLUMN `notification_preferences` JSON NULL AFTER `business_hours`',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'shopkeeper_profiles'
    AND column_name = 'notification_preferences'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;



-- FILE: 2026-09-22-shopkeeper-plan-entitlements.sql
-- =============================================================
-- Shopkeeper plan entitlements
-- =============================================================
-- requireShopkeeperFeature() (lib/shopkeeper.ts) gates EVERY mobile endpoint on
-- two flags: `shopkeeper.mobile_app` plus the per-feature flag. No plan in
-- platform_plans defined any `shopkeeper.*` flag, so every Shopkeeper mobile
-- request returned 403 regardless of plan â€” the whole mobile API was
-- unreachable in practice.
--
-- This adds a dedicated Shopkeeper plan carrying those flags. It is a separate
-- plan rather than flags bolted onto the ERP plans because a Shopkeeper tenant
-- is a different product with a different price point; granting shop features
-- to every Enterprise tenant would be wrong.
--
-- The flag list mirrors SHOPKEEPER_FEATURES in lib/shopkeeper.ts. Adding a
-- feature there without adding it here silently 403s that endpoint.
--
-- Idempotent: safe to re-run.
-- =============================================================

SET NAMES utf8mb4;

INSERT INTO `platform_plans`
  (`code`, `name`, `description`, `price_monthly`, `currency`, `seat_limit`, `entitlements`, `is_active`, `sort_order`)
VALUES (
  'shopkeeper',
  'Shopkeeper',
  'WhatsApp-first plan for a single shop: inbox, catalogue, orders and customers from the mobile app.',
  499.00,
  'INR',
  5,
  JSON_OBJECT(
    'users', 5,
    'employees', 5,
    'modules', JSON_ARRAY('whatsapp', 'products', 'orders', 'contacts'),
    'storage_gb', 5,
    'automations', 10,
    'integrations', 1,
    'jobs', 1000,
    'reports', 'basic',
    'support_level', 'email',
    'api_calls_per_month', 25000,
    'ai_credits_per_month', 1000,
    'feature_flags', JSON_ARRAY(
      'shopkeeper.mobile_app',
      'shopkeeper.whatsapp',
      'shopkeeper.inbox',
      'shopkeeper.contacts',
      'shopkeeper.templates',
      'shopkeeper.campaigns',
      'shopkeeper.automations',
      'shopkeeper.products',
      'shopkeeper.orders',
      'shopkeeper.team',
      'shopkeeper.notifications',
      'shopkeeper.subscription',
      'shopkeeper.settings'
    )
  ),
  1,
  5
)
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `description` = VALUES(`description`),
  `entitlements` = VALUES(`entitlements`),
  `is_active` = VALUES(`is_active`);



-- FILE: 2026-09-22-shopkeeper-products-orders.sql
-- =============================================================
-- Shopkeeper mobile â€” tenant-owned products, orders and order items
-- =============================================================
-- The ERP `products` table is a GLOBAL catalogue with no tenant_id and an
-- inventory/accounting shape (HSN/SAC, GST, valuation method, ledger accounts)
-- that the Shopkeeper app does not use. Exposing it to a mobile tenant would
-- leak every tenant's catalogue, so the Shopkeeper domain gets its own
-- tenant-owned tables instead. Likewise `sales_invoices` / `operations_work_orders`
-- are not tenant-scoped and are not a shop-order service.
--
-- Every table here carries tenant_id and is registered in lib/tenant-tables.ts,
-- so the fail-closed guard in lib/tenant-guard.ts rejects any unscoped query.
--
-- Idempotent: safe to re-run.
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Products
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopkeeper_products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  sku VARCHAR(64) NULL,
  category VARCHAR(120) NULL,
  description TEXT NULL,
  -- Money as DECIMAL, never FLOAT: binary floats cannot represent 0.10 exactly
  -- and order totals are computed from these.
  price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  offer_price DECIMAL(12,2) NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  image_url VARCHAR(500) NULL,
  stock_status ENUM('in_stock','out_of_stock','low_stock') NOT NULL DEFAULT 'in_stock',
  stock_quantity INT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- SKU is unique per tenant, not globally: two shops may legitimately use "A-1".
  UNIQUE KEY uq_shopkeeper_products_sku (tenant_id, sku),
  KEY idx_shopkeeper_products_tenant_status (tenant_id, status),
  KEY idx_shopkeeper_products_tenant_category (tenant_id, category),
  KEY idx_shopkeeper_products_tenant_created (tenant_id, created_at),
  CONSTRAINT fk_shopkeeper_products_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------------
-- Orders
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopkeeper_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  order_number VARCHAR(40) NOT NULL,
  -- INT UNSIGNED to match marketing_whatsapp_contacts.id / _conversations.id;
  -- a wider type here makes the foreign key invalid.
  contact_id INT UNSIGNED NULL,
  conversation_id INT UNSIGNED NULL,
  customer_name VARCHAR(190) NULL,
  customer_phone VARCHAR(40) NULL,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  status ENUM('new','processing','completed','cancelled') NOT NULL DEFAULT 'new',
  payment_status ENUM('pending','paid','cod') NOT NULL DEFAULT 'pending',
  delivery_method ENUM('shop_pickup','home_delivery') NOT NULL DEFAULT 'shop_pickup',
  delivery_address VARCHAR(500) NULL,
  notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shopkeeper_orders_number (tenant_id, order_number),
  KEY idx_shopkeeper_orders_tenant_status (tenant_id, status),
  KEY idx_shopkeeper_orders_tenant_created (tenant_id, created_at),
  KEY idx_shopkeeper_orders_tenant_contact (tenant_id, contact_id),
  KEY idx_shopkeeper_orders_tenant_conversation (tenant_id, conversation_id),
  CONSTRAINT fk_shopkeeper_orders_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  -- Contact/conversation are SET NULL rather than CASCADE: deleting a contact
  -- must never silently destroy financial history.
  CONSTRAINT fk_shopkeeper_orders_contact FOREIGN KEY (contact_id)
    REFERENCES marketing_whatsapp_contacts(id) ON DELETE SET NULL,
  CONSTRAINT fk_shopkeeper_orders_conversation FOREIGN KEY (conversation_id)
    REFERENCES marketing_whatsapp_conversations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------------
-- Order items
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopkeeper_order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NULL,
  -- Name and unit price are COPIED at order time, not joined at read time, so
  -- renaming or repricing a product never rewrites historical orders.
  product_name VARCHAR(190) NOT NULL,
  sku VARCHAR(64) NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  line_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_shopkeeper_order_items_tenant_order (tenant_id, order_id),
  KEY idx_shopkeeper_order_items_tenant_product (tenant_id, product_id),
  CONSTRAINT fk_shopkeeper_order_items_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_shopkeeper_order_items_order FOREIGN KEY (order_id)
    REFERENCES shopkeeper_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_shopkeeper_order_items_product FOREIGN KEY (product_id)
    REFERENCES shopkeeper_products(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;



-- FILE: 2026-09-22-upgrade-attendance-regularisation.sql
-- Upgrade Attendance Regularisation into a proper correction + approval workflow
-- that is tightly linked to the central hr_attendance record.
--
-- Additive and idempotent: every column is nullable and guarded with
-- IF NOT EXISTS so re-running (or the app's lazy ensureRegularisationSchema)
-- is safe even after the runtime already added these objects. Mirrors the
-- columns created lazily in lib/hr-regularisation.ts.

-- Widen the lifecycle status to include Cancelled (base table used an ENUM).
ALTER TABLE `hr_attendance_regularisation`
  MODIFY COLUMN `status` VARCHAR(20) NOT NULL DEFAULT 'Pending';

-- Workflow + snapshot columns (added individually and idempotently).
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `correction_type` VARCHAR(50) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `current_clock_in` DATETIME DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `current_clock_out` DATETIME DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `current_status` VARCHAR(50) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `requested_status` VARCHAR(50) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `department` VARCHAR(180) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `designation` VARCHAR(180) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `reporting_manager` VARCHAR(180) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `requested_by` INT UNSIGNED DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `requested_by_name` VARCHAR(180) DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `rejection_reason` TEXT DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `applied_at` DATETIME DEFAULT NULL;
ALTER TABLE `hr_attendance_regularisation` ADD COLUMN IF NOT EXISTS `attachment_name` VARCHAR(255) DEFAULT NULL;

ALTER TABLE `hr_attendance_regularisation` ADD INDEX IF NOT EXISTS `idx_reg_emp_date` (`employee_id`, `work_date`);

-- Feature slugs already registered by 2026-09-01-add-hr-attendance-regularisation.sql:
--   hr.view_regularisation   â€” view / create own requests
--   hr.manage_regularisation â€” approve / reject / view all requests



-- FILE: 2026-09-23-hr-email-automation.sql
-- =====================================================================
-- HR Email Hub â€” Phase 2: event-driven automation
-- ---------------------------------------------------------------------
-- One row per automated HR email event (LEAVE_APPROVED, PROMOTION_EFFECTIVE,
-- ...). Each row decides whether the event fires, which hr_email_templates
-- row supplies subject/body (NULL => built-in default template baked into
-- lib/hr-email-automation.ts), and whether the reporting manager is CC'd.
--
-- The same table + seed rows are created idempotently at runtime by
-- ensureHrEmailAutomationSchema() in lib/hr-email-automation.ts, so the
-- feature works even if this migration is not run manually in phpMyAdmin.
-- =====================================================================

CREATE TABLE IF NOT EXISTS hr_email_automations (
  event_key   VARCHAR(60)  NOT NULL PRIMARY KEY,
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  template_id BIGINT UNSIGNED NULL,
  cc_manager  TINYINT(1)   NOT NULL DEFAULT 0,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the known events (INSERT IGNORE keeps any admin overrides intact).
INSERT IGNORE INTO hr_email_automations (event_key, enabled, cc_manager) VALUES
  ('leave_submitted',         1, 1),
  ('leave_approved',          1, 1),
  ('leave_rejected',          1, 1),
  ('leave_cancelled',         1, 0),
  ('shift_change_submitted',  1, 1),
  ('shift_change_approved',   1, 1),
  ('shift_change_rejected',   1, 0),
  ('promotion_effective',     1, 1),
  ('support_ticket_created',  1, 0),
  ('offboarding_initiated',   1, 0),
  ('offboarding_completed',   1, 0);



-- FILE: 2026-09-23-mobile-push-infrastructure.sql
-- Production push delivery metadata. Existing rows remain valid; device_id is
-- nullable for legacy registrations and is required by the authenticated API.
ALTER TABLE mobile_device_registrations
  ADD COLUMN IF NOT EXISTS device_id VARCHAR(160) NULL AFTER token_encrypted,
  ADD COLUMN IF NOT EXISTS app_version VARCHAR(40) NULL AFTER device_id;

ALTER TABLE mobile_device_registrations
  ADD UNIQUE KEY IF NOT EXISTS uq_mobile_device_installation (tenant_id, user_id, device_id);

-- A native FCM token belongs to one app installation globally. Older
-- provider-neutral registrations could have the same token under more than
-- one tenant, so revoke and erase every duplicate token before enforcing the
-- global invariant. The app will register the token again for its active
-- authenticated tenant.
UPDATE mobile_device_registrations d
JOIN (
  SELECT token_hash FROM (
    SELECT token_hash FROM mobile_device_registrations
    GROUP BY token_hash HAVING COUNT(*) > 1
  ) duplicate_hashes
) duplicates ON duplicates.token_hash = d.token_hash
SET d.enabled = 0,
    d.token_encrypted = '',
    d.token_hash = SHA2(CONCAT('revoked-mobile-device:', d.id), 256);

ALTER TABLE mobile_device_registrations
  ADD UNIQUE KEY IF NOT EXISTS uq_mobile_device_token_hash (token_hash);

-- Credentials are deliberately not stored in this table. Configure FCM service
-- account values in the deployment's encrypted server-side environment store.



-- FILE: 2026-09-23-mobile-whatsapp-onboarding.sql
CREATE TABLE IF NOT EXISTS mobile_whatsapp_onboarding (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash CHAR(64) NOT NULL,
  tenant_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  mobile_session_id VARCHAR(64) NOT NULL,
  signup_state VARCHAR(191) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  completed_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mobile_wa_launch_token (token_hash),
  UNIQUE KEY uq_mobile_wa_signup_state (signup_state),
  KEY idx_mobile_wa_launch_owner (tenant_id, user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-23-shopkeeper-self-registration.sql
-- Pending applications are deliberately separate from active tenants/users.
-- The application email is unique; approval provisions into the existing tenant system.
CREATE TABLE IF NOT EXISTS shopkeeper_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  business_name VARCHAR(150) NOT NULL,
  business_category VARCHAR(120) NOT NULL,
  owner_name VARCHAR(150) NOT NULL,
  email VARCHAR(190) NOT NULL,
  mobile VARCHAR(40) NOT NULL,
  country VARCHAR(2) NOT NULL,
  state VARCHAR(120) NULL,
  city VARCHAR(120) NOT NULL,
  postal_code VARCHAR(20) NULL,
  password_hash VARCHAR(255) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  terms_accepted_at DATETIME NOT NULL,
  privacy_accepted_at DATETIME NOT NULL,
  tenant_id INT UNSIGNED NULL,
  owner_user_id INT UNSIGNED NULL,
  rejection_reason VARCHAR(500) NULL,
  reviewed_by INT UNSIGNED NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME NULL,
  rejected_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shopkeeper_application_email (email),
  UNIQUE KEY uq_shopkeeper_application_token (token_hash),
  KEY idx_shopkeeper_application_status (status, submitted_at),
  UNIQUE KEY uq_shopkeeper_application_mobile (mobile),
  KEY idx_shopkeeper_application_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shopkeeper_application_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(40) NOT NULL,
  actor_user_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_shopkeeper_app_event (application_id, created_at),
  CONSTRAINT fk_shopkeeper_app_event FOREIGN KEY (application_id) REFERENCES shopkeeper_applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-09-24-crm-lifecycle-overhaul.sql
-- =============================================================
-- Sales CRM lifecycle overhaul (additive, non-destructive)
-- -------------------------------------------------------------
-- Principles:
--   * One row per lead in `sales_leads`. Won / Lost / Follow Up are
--     lifecycle STATES on that row plus outcome metadata columns.
--     There are NO copy/duplicate tables for won or lost leads.
--   * Every business rule funnels through the central service in
--     lib/sales/lead-lifecycle.ts. Nothing writes lifecycle state
--     directly.
--   * History is append-only and immutable (stage / owner history,
--     activity timeline, audit log). Rows are never physically moved
--     or deleted to represent a state change.
--
-- This file documents the target schema for fresh installs. The same
-- objects are also created/altered idempotently at runtime by
-- ensureLeadLifecycleSchema() so existing databases self-heal without
-- a manual migration step.
--
-- This script is SAFE TO RE-RUN. Column / index additions go through
-- helper procedures that check information_schema first, so a database
-- that already has some of these objects will skip them instead of
-- failing with "#1060 Duplicate column name".
-- =============================================================

-- --- Idempotent DDL helpers -----------------------------------------
DROP PROCEDURE IF EXISTS `__cl_add_column`;
DROP PROCEDURE IF EXISTS `__cl_add_key`;

DELIMITER $$

CREATE PROCEDURE `__cl_add_column`(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND COLUMN_NAME = p_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END $$

CREATE PROCEDURE `__cl_add_key`(
  IN p_table VARCHAR(64),
  IN p_key VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND INDEX_NAME = p_key
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD KEY `', p_key, '` ', p_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- --- sales_leads: new nullable lifecycle + qualification columns ----
CALL `__cl_add_column`('sales_leads', 'company_id', "INT UNSIGNED DEFAULT NULL AFTER `company_name`");
CALL `__cl_add_column`('sales_leads', 'priority', "ENUM('Low','Medium','High','Urgent') DEFAULT NULL AFTER `lead_status`");
CALL `__cl_add_column`('sales_leads', 'estimated_value', "DECIMAL(14,2) DEFAULT NULL AFTER `priority`");
CALL `__cl_add_column`('sales_leads', 'currency', "VARCHAR(8) DEFAULT NULL AFTER `estimated_value`");
CALL `__cl_add_column`('sales_leads', 'probability', "TINYINT UNSIGNED DEFAULT NULL AFTER `currency`");
CALL `__cl_add_column`('sales_leads', 'expected_close_date', "DATE DEFAULT NULL AFTER `probability`");
CALL `__cl_add_column`('sales_leads', 'campaign', "VARCHAR(150) DEFAULT NULL AFTER `expected_close_date`");
CALL `__cl_add_column`('sales_leads', 'tags', "VARCHAR(500) DEFAULT NULL AFTER `campaign`");
CALL `__cl_add_column`('sales_leads', 'next_follow_up_at', "DATETIME DEFAULT NULL AFTER `follow_up_date`");
CALL `__cl_add_column`('sales_leads', 'won_at', "DATETIME DEFAULT NULL AFTER `tags`");
CALL `__cl_add_column`('sales_leads', 'won_value', "DECIMAL(14,2) DEFAULT NULL AFTER `won_at`");
CALL `__cl_add_column`('sales_leads', 'won_by', "INT UNSIGNED DEFAULT NULL AFTER `won_value`");
CALL `__cl_add_column`('sales_leads', 'won_notes', "TEXT DEFAULT NULL AFTER `won_by`");
CALL `__cl_add_column`('sales_leads', 'lost_at', "DATETIME DEFAULT NULL AFTER `won_notes`");
CALL `__cl_add_column`('sales_leads', 'lost_reason', "VARCHAR(120) DEFAULT NULL AFTER `lost_at`");
CALL `__cl_add_column`('sales_leads', 'lost_notes', "TEXT DEFAULT NULL AFTER `lost_reason`");
CALL `__cl_add_column`('sales_leads', 'lost_by', "INT UNSIGNED DEFAULT NULL AFTER `lost_notes`");
CALL `__cl_add_column`('sales_leads', 'reopened_at', "DATETIME DEFAULT NULL AFTER `lost_by`");
CALL `__cl_add_column`('sales_leads', 'archived_at', "DATETIME DEFAULT NULL AFTER `reopened_at`");
CALL `__cl_add_column`('sales_leads', 'row_version', "INT UNSIGNED NOT NULL DEFAULT 1 AFTER `archived_at`");

CALL `__cl_add_key`('sales_leads', 'idx_leads_company_id', '(`company_id`)');
CALL `__cl_add_key`('sales_leads', 'idx_leads_next_follow_up', '(`next_follow_up_at`)');
CALL `__cl_add_key`('sales_leads', 'idx_leads_archived', '(`archived_at`)');

-- --- Immutable stage / lifecycle history ----------------------------
CREATE TABLE IF NOT EXISTS `sales_lead_stage_history` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lead_id` INT UNSIGNED NOT NULL,
  `from_status` VARCHAR(40) DEFAULT NULL,
  `to_status` VARCHAR(40) DEFAULT NULL,
  `from_lead_status` VARCHAR(20) DEFAULT NULL,
  `to_lead_status` VARCHAR(20) DEFAULT NULL,
  `note` VARCHAR(500) DEFAULT NULL,
  `changed_by` INT UNSIGNED DEFAULT NULL,
  `changed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_stage_hist_lead` (`lead_id`, `changed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Immutable owner assignment history -----------------------------
CREATE TABLE IF NOT EXISTS `sales_lead_owner_history` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lead_id` INT UNSIGNED NOT NULL,
  `from_owner` INT UNSIGNED DEFAULT NULL,
  `to_owner` INT UNSIGNED DEFAULT NULL,
  `note` VARCHAR(255) DEFAULT NULL,
  `changed_by` INT UNSIGNED DEFAULT NULL,
  `changed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_owner_hist_lead` (`lead_id`, `changed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Unified activity timeline --------------------------------------
CREATE TABLE IF NOT EXISTS `sales_lead_activities` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lead_id` INT UNSIGNED NOT NULL,
  `activity_type` VARCHAR(40) NOT NULL DEFAULT 'note',
  `title` VARCHAR(255) DEFAULT NULL,
  `body` TEXT DEFAULT NULL,
  `ref_type` VARCHAR(40) DEFAULT NULL,
  `ref_id` VARCHAR(64) DEFAULT NULL,
  `occurred_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_activity_lead` (`lead_id`, `occurred_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- First-class follow-up entity -----------------------------------
CREATE TABLE IF NOT EXISTS `sales_lead_followups` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `followup_code` VARCHAR(30) DEFAULT NULL,
  `lead_id` INT UNSIGNED NOT NULL,
  `due_at` DATETIME NOT NULL,
  `channel` VARCHAR(40) DEFAULT NULL,
  `purpose` VARCHAR(255) DEFAULT NULL,
  `status` ENUM('Open','Done','Cancelled') NOT NULL DEFAULT 'Open',
  `outcome` TEXT DEFAULT NULL,
  `assigned_to` INT UNSIGNED DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `completed_by` INT UNSIGNED DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_followup_code` (`followup_code`),
  KEY `idx_followup_lead` (`lead_id`),
  KEY `idx_followup_status_due` (`status`, `due_at`),
  KEY `idx_followup_assignee` (`assigned_to`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Central audit log (all sales entities) -------------------------
CREATE TABLE IF NOT EXISTS `sales_audit_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entity_type` VARCHAR(40) NOT NULL,
  `entity_id` VARCHAR(64) NOT NULL,
  `action` VARCHAR(60) NOT NULL,
  `summary` VARCHAR(500) DEFAULT NULL,
  `meta` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_entity` (`entity_type`, `entity_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- In-app notifications -------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_notifications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `type` VARCHAR(40) NOT NULL DEFAULT 'info',
  `title` VARCHAR(255) NOT NULL,
  `body` VARCHAR(500) DEFAULT NULL,
  `link` VARCHAR(255) DEFAULT NULL,
  `entity_type` VARCHAR(40) DEFAULT NULL,
  `entity_id` VARCHAR(64) DEFAULT NULL,
  `is_read` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_notif_user` (`user_id`, `is_read`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Idempotency guard for lifecycle events -------------------------
CREATE TABLE IF NOT EXISTS `sales_event_dedup` (
  `event_key` VARCHAR(191) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`event_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Feature flags for the new lead views ---------------------------
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT 2, 'View Follow-ups', 'sales.view_followups', 'View and manage the follow-up queue', 17
WHERE NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'sales.view_followups');

-- --- Clean up helper procedures -------------------------------------
DROP PROCEDURE IF EXISTS `__cl_add_column`;
DROP PROCEDURE IF EXISTS `__cl_add_key`;



-- FILE: 2026-09-25-company-master.sql
-- =============================================================
-- Sales Company (Account) master upgrade (additive, non-destructive)
-- -------------------------------------------------------------
-- Principles:
--   * The company is the CANONICAL account record. Leads, meetings,
--     quotations, contracts, onboarding and contacts all reference it
--     by numeric `company_id`. Legacy free-text `company_name` columns
--     are kept for display / backwards compatibility only.
--   * Company codes are generated race-safely via `record_id_sequences`
--     (prefix MCLD) â€” never MAX()+1.
--   * Status / owner / priority changes, archive and merge are recorded
--     append-only in the shared `sales_audit_log`. Companies are soft
--     archived (archived_at), never hard-deleted.
--
-- This file documents the target schema for fresh installs. The same
-- objects are also created/altered idempotently at runtime by
-- ensureCompanyMasterSchema() in lib/sales/company-master.ts so existing
-- databases self-heal without a manual migration step.
--
-- This script is SAFE TO RE-RUN. MySQL 8 has no reliable
-- `ADD COLUMN IF NOT EXISTS`, so each column / key / enum change is
-- applied through helper procedures that first check information_schema
-- and skip anything that already exists (mirrors the runtime helpers
-- addColumnIfMissing / addKeyIfMissing).
-- =============================================================

DELIMITER $$

-- Adds a column only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__cm_add_column` $$
CREATE PROCEDURE `__cm_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

-- Adds an index only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__cm_add_key` $$
CREATE PROCEDURE `__cm_add_key`(IN p_table VARCHAR(64), IN p_key VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_key
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- --- sales_companies: new master columns ----------------------------
CALL `__cm_add_column`('sales_companies', 'legal_name',         '`legal_name` VARCHAR(190) DEFAULT NULL AFTER `company_name`');
CALL `__cm_add_column`('sales_companies', 'domain',             '`domain` VARCHAR(150) DEFAULT NULL AFTER `website`');
CALL `__cm_add_column`('sales_companies', 'phone',              '`phone` VARCHAR(40) DEFAULT NULL AFTER `company_email`');
CALL `__cm_add_column`('sales_companies', 'alt_phone',          '`alt_phone` VARCHAR(40) DEFAULT NULL AFTER `phone`');
CALL `__cm_add_column`('sales_companies', 'address_line',       '`address_line` VARCHAR(255) DEFAULT NULL AFTER `alt_phone`');
CALL `__cm_add_column`('sales_companies', 'city',               '`city` VARCHAR(120) DEFAULT NULL AFTER `address_line`');
CALL `__cm_add_column`('sales_companies', 'state',              '`state` VARCHAR(120) DEFAULT NULL AFTER `city`');
CALL `__cm_add_column`('sales_companies', 'postal_code',        '`postal_code` VARCHAR(30) DEFAULT NULL AFTER `state`');
CALL `__cm_add_column`('sales_companies', 'segment',            '`segment` VARCHAR(80) DEFAULT NULL AFTER `company_type`');
CALL `__cm_add_column`('sales_companies', 'annual_revenue',     '`annual_revenue` DECIMAL(16,2) DEFAULT NULL AFTER `employee_count`');
CALL `__cm_add_column`('sales_companies', 'tags',               '`tags` VARCHAR(500) DEFAULT NULL AFTER `segment`');
CALL `__cm_add_column`('sales_companies', 'source',             '`source` VARCHAR(120) DEFAULT NULL AFTER `tags`');
CALL `__cm_add_column`('sales_companies', 'description',        '`description` TEXT DEFAULT NULL AFTER `source`');
CALL `__cm_add_column`('sales_companies', 'account_health',     '`account_health` TINYINT UNSIGNED DEFAULT NULL AFTER `priority`');
CALL `__cm_add_column`('sales_companies', 'first_contact_date', '`first_contact_date` DATE DEFAULT NULL AFTER `last_contact_date`');
CALL `__cm_add_column`('sales_companies', 'last_activity_at',   '`last_activity_at` DATETIME DEFAULT NULL AFTER `first_contact_date`');
CALL `__cm_add_column`('sales_companies', 'archived_at',        '`archived_at` DATETIME DEFAULT NULL AFTER `last_activity_at`');
CALL `__cm_add_column`('sales_companies', 'archived_by',        '`archived_by` INT UNSIGNED DEFAULT NULL AFTER `archived_at`');
CALL `__cm_add_column`('sales_companies', 'merged_into_id',     '`merged_into_id` INT UNSIGNED DEFAULT NULL AFTER `archived_by`');
CALL `__cm_add_column`('sales_companies', 'row_version',        '`row_version` INT UNSIGNED NOT NULL DEFAULT 1 AFTER `merged_into_id`');

-- Widen enums additively (existing values are preserved; MODIFY is naturally idempotent).
ALTER TABLE `sales_companies`
  MODIFY `status` ENUM('New','Contacted','Qualified','Customer','Inactive','Lost') NOT NULL DEFAULT 'New',
  MODIFY `priority` ENUM('Low','Medium','High','Critical') DEFAULT NULL;

CALL `__cm_add_key`('sales_companies', 'idx_companies_priority', 'KEY `idx_companies_priority` (`priority`)');
CALL `__cm_add_key`('sales_companies', 'idx_companies_domain',   'KEY `idx_companies_domain` (`domain`)');
CALL `__cm_add_key`('sales_companies', 'idx_companies_archived', 'KEY `idx_companies_archived` (`archived_at`)');
CALL `__cm_add_key`('sales_companies', 'idx_companies_assigned', 'KEY `idx_companies_assigned` (`assigned_to`)');

-- --- Relational contacts parented to a company ----------------------
CREATE TABLE IF NOT EXISTS `sales_contacts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `company_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `title` VARCHAR(150) DEFAULT NULL,
  `email` VARCHAR(190) DEFAULT NULL,
  `phone` VARCHAR(40) DEFAULT NULL,
  `linkedin_url` VARCHAR(190) DEFAULT NULL,
  `is_primary` TINYINT(1) NOT NULL DEFAULT 0,
  `notes` VARCHAR(500) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_contacts_company` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- company_id linkage on downstream Sales tables ------------------
CALL `__cm_add_column`('sales_meetings',   'company_id', '`company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`');
CALL `__cm_add_column`('sales_quotations', 'company_id', '`company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`');
CALL `__cm_add_column`('sales_contracts',  'company_id', '`company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`');
CALL `__cm_add_column`('sales_onboarding', 'company_id', '`company_id` INT UNSIGNED DEFAULT NULL AFTER `company_name`');

CALL `__cm_add_key`('sales_meetings',   'idx_sales_meetings_company_id',   'KEY `idx_sales_meetings_company_id` (`company_id`)');
CALL `__cm_add_key`('sales_quotations', 'idx_sales_quotations_company_id', 'KEY `idx_sales_quotations_company_id` (`company_id`)');
CALL `__cm_add_key`('sales_contracts',  'idx_sales_contracts_company_id',  'KEY `idx_sales_contracts_company_id` (`company_id`)');
CALL `__cm_add_key`('sales_onboarding', 'idx_sales_onboarding_company_id', 'KEY `idx_sales_onboarding_company_id` (`company_id`)');

-- --- Backfill company_id by unambiguous exact name match ------------
-- Only assigns when the name resolves to exactly one company.
UPDATE `sales_leads` t
  JOIN (SELECT company_name, MIN(id) AS cid, COUNT(*) AS n FROM sales_companies
        WHERE archived_at IS NULL AND company_name <> '' GROUP BY company_name) c
    ON c.company_name = t.company_name AND c.n = 1
  SET t.company_id = c.cid
  WHERE t.company_id IS NULL AND t.company_name IS NOT NULL AND t.company_name <> '';

-- --- Clean up helper procedures -------------------------------------
DROP PROCEDURE IF EXISTS `__cm_add_column`;
DROP PROCEDURE IF EXISTS `__cm_add_key`;



-- FILE: 2026-09-26-upgrade-sales-quotations.sql
-- =====================================================================
-- Upgrade Sales Quotations into a full commercial quoting system.
--
-- Adds relational links (company / contact / lead / meeting), a proper
-- line-item table, GST-aware financial columns, versioning/revision
-- tracking and a lifecycle audit trail. Mirrors lib/sales/quotation-service.ts
-- `ensureQuotationSchema()`, which applies the same changes idempotently at
-- runtime so installs that never run this file still upgrade cleanly.
--
-- This script is fully idempotent: every column / index change is guarded
-- against information_schema, so it is safe to re-run even after the runtime
-- self-healer (or a previous partial run) has already applied some of it.
-- Requires MySQL 5.7+ / MariaDB 10.x. Run as a single script; DELIMITER
-- handling is needed for the helper procedures below.
-- =====================================================================

DELIMITER $$

-- --- Idempotent helper procedures ----------------------------------------
DROP PROCEDURE IF EXISTS `mnt_add_column`$$
CREATE PROCEDURE `mnt_add_column`(IN in_table VARCHAR(64), IN in_column VARCHAR(64), IN in_definition TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = in_table AND column_name = in_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', in_table, '` ADD COLUMN `', in_column, '` ', in_definition);
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS `mnt_add_index`$$
CREATE PROCEDURE `mnt_add_index`(IN in_table VARCHAR(64), IN in_index VARCHAR(64), IN in_columns TEXT, IN in_unique TINYINT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = in_table AND index_name = in_index
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', in_table, '` ADD ', IF(in_unique = 1, 'UNIQUE ', ''), 'INDEX `', in_index, '` (', in_columns, ')');
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DROP PROCEDURE IF EXISTS `mnt_drop_index`$$
CREATE PROCEDURE `mnt_drop_index`(IN in_table VARCHAR(64), IN in_index VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = in_table AND index_name = in_index
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', in_table, '` DROP INDEX `', in_index, '`');
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

-- --- Header: relational + snapshot columns -------------------------------
CALL `mnt_add_column`('sales_quotations', 'company_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'contact_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'lead_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'meeting_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'owner_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'contact_email', "VARCHAR(190) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'contact_phone', "VARCHAR(60) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'contact_designation', "VARCHAR(120) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'reference', "VARCHAR(190) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'source_type', "VARCHAR(20) DEFAULT 'Manual'");
CALL `mnt_add_column`('sales_quotations', 'source_module', "VARCHAR(40) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'source_record_id', "VARCHAR(64) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'bill_to_address', "TEXT DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'ship_to_address', "TEXT DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'place_of_supply', "VARCHAR(80) DEFAULT NULL");

-- --- Header: financial columns -------------------------------------------
CALL `mnt_add_column`('sales_quotations', 'currency', "VARCHAR(8) NOT NULL DEFAULT 'INR'");
CALL `mnt_add_column`('sales_quotations', 'exchange_rate', "DECIMAL(14,6) NOT NULL DEFAULT 1");
CALL `mnt_add_column`('sales_quotations', 'tax_mode', "ENUM('Exclusive','Inclusive') NOT NULL DEFAULT 'Exclusive'");
CALL `mnt_add_column`('sales_quotations', 'gst_treatment', "ENUM('Intra','Inter','None') NOT NULL DEFAULT 'Intra'");
CALL `mnt_add_column`('sales_quotations', 'subtotal', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'discount_type', "ENUM('none','percent','fixed') NOT NULL DEFAULT 'none'");
CALL `mnt_add_column`('sales_quotations', 'discount_value', "DECIMAL(14,4) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'discount_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'taxable_value', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'cgst_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'sgst_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'igst_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'tax_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'round_off', "DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `mnt_add_column`('sales_quotations', 'grand_total', "DECIMAL(14,2) NOT NULL DEFAULT 0");

-- --- Header: terms + notes ------------------------------------------------
CALL `mnt_add_column`('sales_quotations', 'payment_terms', "VARCHAR(120) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'delivery_terms', "VARCHAR(255) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'terms_text', "TEXT DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'customer_notes', "TEXT DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'internal_notes', "TEXT DEFAULT NULL");

-- --- Header: versioning + lifecycle --------------------------------------
CALL `mnt_add_column`('sales_quotations', 'version', "INT UNSIGNED NOT NULL DEFAULT 1");
CALL `mnt_add_column`('sales_quotations', 'root_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'superseded_by', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'is_current', "TINYINT(1) NOT NULL DEFAULT 1");
CALL `mnt_add_column`('sales_quotations', 'row_version', "INT UNSIGNED NOT NULL DEFAULT 1");
CALL `mnt_add_column`('sales_quotations', 'sent_at', "DATETIME DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'viewed_at', "DATETIME DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'accepted_at', "DATETIME DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'accepted_by', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'rejected_at', "DATETIME DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'rejected_by', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'rejection_reason', "VARCHAR(120) DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'rejection_notes', "TEXT DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'converted_contract_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'converted_invoice_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'cancelled_at', "DATETIME DEFAULT NULL");
CALL `mnt_add_column`('sales_quotations', 'archived_at', "DATETIME DEFAULT NULL");

-- Widen the status enum to include Cancelled (safe to re-run).
ALTER TABLE `sales_quotations`
  MODIFY COLUMN `status` ENUM('Draft','Sent','Accepted','Rejected','Expired','Cancelled') NOT NULL DEFAULT 'Draft';

-- The customer-facing quote code is now unique per version, not globally,
-- so a revision keeps the same MQ-xxx number with an incremented version.
CALL `mnt_drop_index`('sales_quotations', 'uniq_quote_code');
CALL `mnt_add_index`('sales_quotations', 'uniq_quote_code_version', '`quote_code`, `version`', 1);
CALL `mnt_add_index`('sales_quotations', 'idx_quotations_company', '`company_id`', 0);
CALL `mnt_add_index`('sales_quotations', 'idx_quotations_lead', '`lead_id`', 0);
CALL `mnt_add_index`('sales_quotations', 'idx_quotations_status', '`status`', 0);
CALL `mnt_add_index`('sales_quotations', 'idx_quotations_root', '`root_id`', 0);

-- Backfill root_id for legacy rows (each is its own root).
UPDATE `sales_quotations` SET `root_id` = `id` WHERE `root_id` IS NULL;
-- Seed the new financial columns from the legacy single total.
UPDATE `sales_quotations`
   SET `grand_total` = `total_amount`,
       `subtotal` = `total_amount`,
       `taxable_value` = `total_amount`
 WHERE `grand_total` = 0 AND `total_amount` <> 0;

-- --- Line items -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_quotation_items` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `quotation_id` INT UNSIGNED NOT NULL,
  `line_no` INT UNSIGNED NOT NULL DEFAULT 1,
  `item_type` VARCHAR(30) NOT NULL DEFAULT 'Service',
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `hsn_sac` VARCHAR(20) DEFAULT NULL,
  `quantity` DECIMAL(14,3) NOT NULL DEFAULT 1,
  `unit` VARCHAR(30) DEFAULT NULL,
  `rate` DECIMAL(14,4) NOT NULL DEFAULT 0,
  `discount_type` ENUM('none','percent','fixed') NOT NULL DEFAULT 'none',
  `discount_value` DECIMAL(14,4) NOT NULL DEFAULT 0,
  `discount_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `tax_rate` DECIMAL(6,3) NOT NULL DEFAULT 0,
  `taxable_value` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `cgst` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `sgst` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `igst` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `tax_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `line_total` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_quotation_items_quote` (`quotation_id`),
  CONSTRAINT `fk_quotation_items_quote` FOREIGN KEY (`quotation_id`)
    REFERENCES `sales_quotations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Lifecycle audit trail ------------------------------------------------
CREATE TABLE IF NOT EXISTS `sales_quotation_events` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `quotation_id` INT UNSIGNED NOT NULL,
  `event_type` VARCHAR(40) NOT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  `meta` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_quotation_events_quote` (`quotation_id`),
  CONSTRAINT `fk_quotation_events_quote` FOREIGN KEY (`quotation_id`)
    REFERENCES `sales_quotations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --- Downstream links back to the source quotation ------------------------
CALL `mnt_add_column`('sales_contracts', 'source_quotation_id', "INT UNSIGNED DEFAULT NULL");
CALL `mnt_add_column`('sales_invoices', 'source_quotation_id', "INT UNSIGNED DEFAULT NULL");

-- --- Clean up helper procedures ------------------------------------------
DROP PROCEDURE IF EXISTS `mnt_add_column`;
DROP PROCEDURE IF EXISTS `mnt_add_index`;
DROP PROCEDURE IF EXISTS `mnt_drop_index`;



-- FILE: 2026-09-27-upgrade-sales-onboarding.sql
-- =============================================================
-- Client Onboarding (Implementation / Activation) upgrade
-- (additive, non-destructive)
-- -------------------------------------------------------------
-- Turns the simple `sales_onboarding` table into a relational
-- client-implementation lifecycle:
--   * Free-text company / contract / owner become real foreign keys
--     (company_id, contract_id, quotation_id, lead_id, contact_id,
--      owner_id, kickoff_meeting_id) into the canonical Sales masters.
--   * Adds planning + lifecycle fields (priority, health, progress_pct,
--     target/actual completion, go-live, hold/block/cancel, handover).
--   * Adds optimistic-concurrency (row_version) and soft-archive
--     (archived_at) so records are never hard-deleted by default.
--   * Adds lightweight owned sub-entities (checklist, tasks, milestones,
--     documents, risks/blockers, team) plus append-only activity + history
--     and reusable onboarding templates.
--   * Links `sales_meetings.onboarding_id` so a kickoff traces both ways.
--   * Onboarding codes continue the legacy `OB-###` sequence race-safely
--     through `record_id_sequences` (prefix OB) â€” never MAX()+1.
--
-- This file documents the target schema for fresh installs. The SAME
-- objects are created/altered idempotently at runtime by
-- ensureOnboardingSchema() in lib/sales/onboarding-service.ts, so existing
-- databases self-heal without running this migration by hand.
--
-- SAFE TO RE-RUN. MySQL 8 has no reliable `ADD COLUMN IF NOT EXISTS`, so
-- each column / key change goes through helper procedures that first
-- check information_schema and skip anything that already exists
-- (mirrors addColumnIfMissing / addKeyIfMissing in the service).
-- =============================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS `__ob_add_column` $$
CREATE PROCEDURE `__ob_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__ob_add_key` $$
CREATE PROCEDURE `__ob_add_key`(IN p_table VARCHAR(64), IN p_key VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_key
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- -------------------------------------------------------------
-- 1. New columns on sales_onboarding
-- -------------------------------------------------------------

-- Relational linkage
CALL __ob_add_column('sales_onboarding', 'company_id',          '`company_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'contact_id',          '`contact_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'contract_id',         '`contract_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'quotation_id',        '`quotation_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'lead_id',             '`lead_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'owner_id',            '`owner_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'kickoff_meeting_id',  '`kickoff_meeting_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'template_id',         '`template_id` INT UNSIGNED DEFAULT NULL');

-- Denormalized display fields (kept in sync from the resolved relations)
CALL __ob_add_column('sales_onboarding', 'contact_person',      '`contact_person` VARCHAR(150) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'contract_code',       '`contract_code` VARCHAR(40) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'currency',            '`currency` VARCHAR(8) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'contract_value',      '`contract_value` DECIMAL(14,2) DEFAULT NULL');

-- Planning + lifecycle
CALL __ob_add_column('sales_onboarding', 'priority',                "`priority` ENUM('Low','Medium','High','Urgent') NOT NULL DEFAULT 'Medium'");
CALL __ob_add_column('sales_onboarding', 'health',                  "`health` ENUM('Healthy','At Risk','Blocked') NOT NULL DEFAULT 'Healthy'");
CALL __ob_add_column('sales_onboarding', 'progress_pct',            '`progress_pct` TINYINT UNSIGNED NOT NULL DEFAULT 0');
CALL __ob_add_column('sales_onboarding', 'target_completion_date',  '`target_completion_date` DATE DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'completed_at',            '`completed_at` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'completed_by',            '`completed_by` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'go_live_date',            '`go_live_date` DATE DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'go_live_notes',           '`go_live_notes` TEXT DEFAULT NULL');

-- Hold / block / cancel
CALL __ob_add_column('sales_onboarding', 'hold_reason',            '`hold_reason` VARCHAR(255) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'hold_since',             '`hold_since` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'expected_resume_date',   '`expected_resume_date` DATE DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'blocked_reason',         '`blocked_reason` VARCHAR(255) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'blocked_since',          '`blocked_since` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'cancel_reason',          '`cancel_reason` VARCHAR(255) DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'cancelled_at',           '`cancelled_at` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'cancelled_by',           '`cancelled_by` INT UNSIGNED DEFAULT NULL');

-- Handover
CALL __ob_add_column('sales_onboarding', 'handover_to_id',         '`handover_to_id` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'handover_at',            '`handover_at` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'handover_notes',         '`handover_notes` TEXT DEFAULT NULL');

-- Notes / scope
CALL __ob_add_column('sales_onboarding', 'requirements_summary',   '`requirements_summary` TEXT DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'scope_notes',            '`scope_notes` TEXT DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'internal_notes',         '`internal_notes` TEXT DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'customer_notes',         '`customer_notes` TEXT DEFAULT NULL');

-- Concurrency + soft archive + authorship
CALL __ob_add_column('sales_onboarding', 'row_version',            '`row_version` INT UNSIGNED NOT NULL DEFAULT 1');
CALL __ob_add_column('sales_onboarding', 'archived_at',            '`archived_at` DATETIME DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'created_by',             '`created_by` INT UNSIGNED DEFAULT NULL');
CALL __ob_add_column('sales_onboarding', 'updated_by',             '`updated_by` INT UNSIGNED DEFAULT NULL');

-- Widen the legacy stage/status ENUMs to free-form vocabularies (keeps old values).
ALTER TABLE `sales_onboarding` MODIFY `current_stage` VARCHAR(40) NOT NULL DEFAULT 'Planning';
ALTER TABLE `sales_onboarding` MODIFY `status` VARCHAR(20) NOT NULL DEFAULT 'Not Started';

-- Indexes for the common list filters.
CALL __ob_add_key('sales_onboarding', 'idx_ob_company',  'KEY `idx_ob_company` (`company_id`)');
CALL __ob_add_key('sales_onboarding', 'idx_ob_contract', 'KEY `idx_ob_contract` (`contract_id`)');
CALL __ob_add_key('sales_onboarding', 'idx_ob_status',   'KEY `idx_ob_status` (`status`)');
CALL __ob_add_key('sales_onboarding', 'idx_ob_owner',    'KEY `idx_ob_owner` (`owner_id`)');
CALL __ob_add_key('sales_onboarding', 'idx_ob_archived', 'KEY `idx_ob_archived` (`archived_at`)');

-- Kickoff meetings link back to onboarding.
CALL __ob_add_column('sales_meetings', 'onboarding_id', '`onboarding_id` INT UNSIGNED DEFAULT NULL');

-- -------------------------------------------------------------
-- 2. Owned sub-entities, timeline, history, templates
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `sales_onboarding_checklist` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `stage` VARCHAR(40) DEFAULT NULL,
  `is_required` TINYINT(1) NOT NULL DEFAULT 0,
  `status` ENUM('Pending','In Progress','Done','N/A') NOT NULL DEFAULT 'Pending',
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `due_date` DATE DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_checklist_ob` (`onboarding_id`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_tasks` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `status` ENUM('Open','In Progress','Done','Cancelled') NOT NULL DEFAULT 'Open',
  `priority` ENUM('Low','Medium','High','Urgent') NOT NULL DEFAULT 'Medium',
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `due_date` DATE DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_tasks_ob` (`onboarding_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_milestones` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `status` ENUM('Pending','In Progress','Done','Missed') NOT NULL DEFAULT 'Pending',
  `due_date` DATE DEFAULT NULL,
  `completed_date` DATE DEFAULT NULL,
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_milestones_ob` (`onboarding_id`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_documents` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `doc_status` ENUM('Requested','Received','Verified','Rejected','N/A') NOT NULL DEFAULT 'Requested',
  `is_required` TINYINT(1) NOT NULL DEFAULT 0,
  `file_url` VARCHAR(500) DEFAULT NULL,
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `due_date` DATE DEFAULT NULL,
  `verified_by` INT UNSIGNED DEFAULT NULL,
  `verified_at` DATETIME DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_docs_ob` (`onboarding_id`, `doc_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_risks` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `kind` ENUM('Risk','Blocker') NOT NULL DEFAULT 'Risk',
  `severity` ENUM('Low','Medium','High','Critical') NOT NULL DEFAULT 'Medium',
  `status` ENUM('Open','Mitigating','Resolved') NOT NULL DEFAULT 'Open',
  `mitigation` TEXT DEFAULT NULL,
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `due_date` DATE DEFAULT NULL,
  `opened_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `resolved_at` DATETIME DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_risks_ob` (`onboarding_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_team` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `role` VARCHAR(80) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_ob_team` (`onboarding_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_activities` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `activity_type` VARCHAR(40) NOT NULL DEFAULT 'note',
  `title` VARCHAR(255) DEFAULT NULL,
  `body` TEXT DEFAULT NULL,
  `ref_type` VARCHAR(40) DEFAULT NULL,
  `ref_id` VARCHAR(64) DEFAULT NULL,
  `occurred_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_activity` (`onboarding_id`, `occurred_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_history` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_id` INT UNSIGNED NOT NULL,
  `field` VARCHAR(40) NOT NULL,
  `from_value` VARCHAR(255) DEFAULT NULL,
  `to_value` VARCHAR(255) DEFAULT NULL,
  `note` VARCHAR(500) DEFAULT NULL,
  `changed_by` INT UNSIGNED DEFAULT NULL,
  `changed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ob_history` (`onboarding_id`, `changed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sales_onboarding_templates` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(150) NOT NULL,
  `description` VARCHAR(500) DEFAULT NULL,
  `checklist` JSON DEFAULT NULL,
  `milestones` JSON DEFAULT NULL,
  `documents` JSON DEFAULT NULL,
  `tasks` JSON DEFAULT NULL,
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_ob_template_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- 3. Race-safe numbering (prefix OB) seeded from the legacy MAX
-- -------------------------------------------------------------
INSERT INTO record_id_sequences (prefix, next_number)
SELECT 'OB', COALESCE(MAX(CAST(REGEXP_REPLACE(onboarding_code, '^[^0-9]*', '') AS UNSIGNED)), 0)
FROM sales_onboarding
WHERE onboarding_code REGEXP '^OB-?[0-9]+$'
ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number));

-- -------------------------------------------------------------
-- 4. Default onboarding template (only when none exist)
-- -------------------------------------------------------------
INSERT INTO `sales_onboarding_templates` (name, description, checklist, milestones, documents, tasks)
SELECT
  'Standard Implementation',
  'Default onboarding playbook for new client implementations.',
  JSON_ARRAY(
    JSON_OBJECT('title','Signed contract received','stage','Planning','is_required',1),
    JSON_OBJECT('title','Kickoff meeting scheduled','stage','Kickoff','is_required',1),
    JSON_OBJECT('title','Requirements gathered','stage','Setup','is_required',1),
    JSON_OBJECT('title','Environment provisioned','stage','Configuration','is_required',1),
    JSON_OBJECT('title','Data migration complete','stage','Integration','is_required',0),
    JSON_OBJECT('title','User training delivered','stage','Training','is_required',1),
    JSON_OBJECT('title','UAT sign-off','stage','UAT','is_required',1),
    JSON_OBJECT('title','Go-live checklist confirmed','stage','Go-Live','is_required',1)
  ),
  JSON_ARRAY(
    JSON_OBJECT('name','Kickoff complete'),
    JSON_OBJECT('name','Configuration complete'),
    JSON_OBJECT('name','Go-live')
  ),
  JSON_ARRAY(
    JSON_OBJECT('name','Signed contract','is_required',1),
    JSON_OBJECT('name','Requirements document','is_required',1),
    JSON_OBJECT('name','UAT sign-off','is_required',1)
  ),
  JSON_ARRAY()
WHERE NOT EXISTS (SELECT 1 FROM `sales_onboarding_templates`);

-- -------------------------------------------------------------
-- 5. Clean up helper procedures
-- -------------------------------------------------------------
DROP PROCEDURE IF EXISTS `__ob_add_column`;
DROP PROCEDURE IF EXISTS `__ob_add_key`;



-- FILE: 2026-09-28-upgrade-sales-forecast.sql
-- Upgrade Sales â†’ Forecast into a real CRM forecasting layer.
--
-- The quarterly forecast is now COMPUTED on demand from live Sales records
-- (leads â†’ quotations â†’ contracts) and Finance actuals (sales_invoices), so the
-- legacy `sales_revenue_forecast` table of hand-typed numbers is no longer the
-- source of truth. It is intentionally left in place (untouched) for historical
-- reference and backward compatibility with the sales dashboard.
--
-- The only rows Forecast now persists are manager MANUAL ADJUSTMENTS / TARGETS,
-- kept separate from the system-calculated numbers and always carrying a reason.
-- Codes are allocated race-safely through the shared record_id_sequences table
-- (prefix FA), never via MAX()+1.

CREATE TABLE IF NOT EXISTS `sales_forecast_adjustments` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `adjustment_code` VARCHAR(30) NOT NULL,
  `fy_start_year` SMALLINT UNSIGNED NOT NULL,
  `quarter` TINYINT UNSIGNED NOT NULL,
  `adjustment_type` ENUM('Expected','Best Case','Worst Case','Target') NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_forecast_adj_code` (`adjustment_code`),
  KEY `idx_forecast_adj_period` (`fy_start_year`, `quarter`),
  KEY `idx_forecast_adj_owner` (`owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the FA numbering sequence so the first generated code is FA-0001.
INSERT INTO `record_id_sequences` (`prefix`, `next_number`) VALUES ('FA', 0)
ON DUPLICATE KEY UPDATE `prefix` = VALUES(`prefix`);



-- FILE: 2026-09-29-vendor-master-upgrade.sql
-- =============================================================
-- Vendor master upgrade (additive, non-destructive)
-- -------------------------------------------------------------
-- Adds the vendor-first master columns and the GSTIN verification
-- snapshot columns to `customers_vendors`, plus the indexes that back
-- the list filters (status, category, GST status) and the GSTIN
-- duplicate lookup.
--
-- The same columns are also created idempotently at runtime by
-- ensureCustomerVendorGstColumns() in lib/finance-ensure.ts, so existing
-- databases self-heal without this migration. This file documents the
-- target schema for fresh installs and adds the supporting indexes that
-- the runtime helper does not create.
--
-- SAFE TO RE-RUN. MySQL 8 has no reliable `ADD COLUMN IF NOT EXISTS`, so
-- every column / index change goes through helper procedures that check
-- information_schema first and skip anything that already exists.
-- =============================================================

DELIMITER $$

-- Adds a column only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__vm_add_column` $$
CREATE PROCEDURE `__vm_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

-- Adds an index only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__vm_add_index` $$
CREATE PROCEDURE `__vm_add_index`(IN p_table VARCHAR(64), IN p_index VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_index
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- ---- Vendor master columns (mirror lib/finance-ensure.ts) -----------------
CALL `__vm_add_column`('customers_vendors', 'trade_name',              'trade_name VARCHAR(255) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'vendor_category',         'vendor_category VARCHAR(60) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'registered_address',      'registered_address TEXT DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'upi_id',                  'upi_id VARCHAR(120) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'tds_applicable',          'tds_applicable TINYINT(1) NOT NULL DEFAULT 0');
CALL `__vm_add_column`('customers_vendors', 'kyc_status',              'kyc_status VARCHAR(30) DEFAULT NULL');

-- ---- GSTIN verification snapshot columns ----------------------------------
CALL `__vm_add_column`('customers_vendors', 'gst_trade_name',          'gst_trade_name VARCHAR(255) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_status',              'gst_status VARCHAR(40) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_taxpayer_type',       'gst_taxpayer_type VARCHAR(60) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'business_constitution',   'business_constitution VARCHAR(120) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_registration_date',   'gst_registration_date VARCHAR(20) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_cancellation_date',   'gst_cancellation_date VARCHAR(20) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_block_status',        'gst_block_status VARCHAR(40) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_verification_status', 'gst_verification_status VARCHAR(30) DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_verified_at',         'gst_verified_at DATETIME DEFAULT NULL');
CALL `__vm_add_column`('customers_vendors', 'gst_verification_source', 'gst_verification_source VARCHAR(60) DEFAULT NULL');

-- ---- Indexes backing the list filters and the GSTIN duplicate lookup ------
CALL `__vm_add_index`('customers_vendors', 'idx_cv_category',    'KEY idx_cv_category (vendor_category)');
CALL `__vm_add_index`('customers_vendors', 'idx_cv_gst_status',  'KEY idx_cv_gst_status (gst_verification_status)');
CALL `__vm_add_index`('customers_vendors', 'idx_cv_tds',         'KEY idx_cv_tds (tds_applicable)');
CALL `__vm_add_index`('customers_vendors', 'idx_cv_party_type',  'KEY idx_cv_party_type (party_type)');

-- The purchase-bills â†’ vendor join (Vendor 360 + list outstanding) filters on
-- vendor_id; index it so the correlated outstanding subquery stays cheap.
CALL `__vm_add_index`('purchase_bills', 'idx_pb_vendor_id', 'KEY idx_pb_vendor_id (vendor_id)');

DROP PROCEDURE IF EXISTS `__vm_add_column`;
DROP PROCEDURE IF EXISTS `__vm_add_index`;



-- FILE: 2026-09-30-purchase-bill-master-upgrade.sql
-- =============================================================
-- Purchase Bill master upgrade (Phases 1â€“5, additive & non-destructive)
-- -------------------------------------------------------------
-- Promotes `bill_id` (PB-2026-000001, server-generated & immutable) to the
-- business key, adds the frozen vendor snapshot, the place-of-supply / GST
-- split fields, the accounting heads and the document attachment columns.
--
-- The same columns + index changes are also applied idempotently at runtime by
-- ensurePurchaseBillColumns() in lib/finance-ensure.ts, so existing databases
-- self-heal without this migration. This file documents the target schema for
-- fresh installs.
--
-- SAFE TO RE-RUN. MySQL 8 has no reliable `ADD COLUMN IF NOT EXISTS`, so every
-- change goes through helper procedures that check information_schema first.
-- =============================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS `__pb_add_column` $$
CREATE PROCEDURE `__pb_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__pb_add_index` $$
CREATE PROCEDURE `__pb_add_index`(IN p_table VARCHAR(64), IN p_index VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_index
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__pb_drop_index` $$
CREATE PROCEDURE `__pb_drop_index`(IN p_table VARCHAR(64), IN p_index VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_index
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` DROP INDEX `', p_index, '`');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- ---- Phase 1: immutable, server-generated Bill ID -------------------------
CALL `__pb_add_column`('purchase_bills', 'bill_id', 'bill_id VARCHAR(30) DEFAULT NULL');

-- ---- Phase 4: bill information --------------------------------------------
CALL `__pb_add_column`('purchase_bills', 'bill_number',       'bill_number VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'grn_number',        'grn_number VARCHAR(60) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'accounting_period', 'accounting_period VARCHAR(20) DEFAULT NULL');

-- ---- Phase 2/3: frozen vendor snapshot ------------------------------------
CALL `__pb_add_column`('purchase_bills', 'vendor_legal_name',     'vendor_legal_name VARCHAR(255) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'vendor_gstin',          'vendor_gstin VARCHAR(20) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'vendor_pan',            'vendor_pan VARCHAR(15) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'vendor_tan',            'vendor_tan VARCHAR(15) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'vendor_state',          'vendor_state VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'vendor_state_code',     'vendor_state_code VARCHAR(6) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'gst_registration_type', 'gst_registration_type VARCHAR(40) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'gst_status',            'gst_status VARCHAR(40) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'currency',              'currency VARCHAR(10) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'payment_terms',         'payment_terms VARCHAR(40) DEFAULT NULL');

-- ---- Phase 4/9: billing + place of supply ---------------------------------
CALL `__pb_add_column`('purchase_bills', 'billing_address',      'billing_address TEXT DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'supply_location',      'supply_location VARCHAR(190) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'place_of_supply',      'place_of_supply VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'place_of_supply_code', 'place_of_supply_code VARCHAR(6) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'supply_type',          'supply_type VARCHAR(20) DEFAULT NULL');

-- ---- Phase 5: GST rate + TDS base -----------------------------------------
CALL `__pb_add_column`('purchase_bills', 'gst_rate', 'gst_rate DECIMAL(6,2) NOT NULL DEFAULT 0');
CALL `__pb_add_column`('purchase_bills', 'tds_base', 'tds_base DECIMAL(14,2) NOT NULL DEFAULT 0');

-- ---- Phase 4: accounting heads --------------------------------------------
CALL `__pb_add_column`('purchase_bills', 'expense_account', 'expense_account VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'payable_account', 'payable_account VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'cost_centre',     'cost_centre VARCHAR(120) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'department',      'department VARCHAR(120) DEFAULT NULL');

-- ---- Phase 4: document attachments ----------------------------------------
CALL `__pb_add_column`('purchase_bills', 'bill_attachment_url', 'bill_attachment_url VARCHAR(500) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'po_document_url',     'po_document_url VARCHAR(500) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'grn_document_url',    'grn_document_url VARCHAR(500) DEFAULT NULL');
CALL `__pb_add_column`('purchase_bills', 'supporting_docs_url', 'supporting_docs_url TEXT DEFAULT NULL');

-- ---- Backfill a stable immutable id for any pre-existing rows --------------
UPDATE purchase_bills
   SET bill_id = CONCAT('PB-LEGACY-', LPAD(id, 6, '0'))
 WHERE bill_id IS NULL OR bill_id = '';

-- ---- Index changes: PO Number is now optional; Bill ID is the key ---------
CALL `__pb_drop_index`('purchase_bills', 'uq_purchase_po');
CALL `__pb_add_index`('purchase_bills', 'uq_pb_bill_id',      'UNIQUE KEY uq_pb_bill_id (bill_id)');
CALL `__pb_add_index`('purchase_bills', 'idx_pb_bill_number', 'KEY idx_pb_bill_number (bill_number)');

DROP PROCEDURE IF EXISTS `__pb_add_column`;
DROP PROCEDURE IF EXISTS `__pb_add_index`;
DROP PROCEDURE IF EXISTS `__pb_drop_index`;



-- FILE: 2026-10-01-gst-input-and-line-items.sql
-- =============================================================
-- Purchase Bill line items + GST Input (ITC) subsystem  (Phases 6â€“20)
-- -------------------------------------------------------------
-- Phase 6/7   purchase_bill_items â€” multi line items per bill with HSN/SAC,
--             per-line discount and GST split.
-- Phase 10    finance_tax_rates gains effective-dating (effective_from /
--             effective_to / status) so a rate is resolved as-of the bill date.
-- Phase 11-18 finance_gst_input â€” one Input-GST / ITC record per source bill,
--             carrying the tax split, the ITC ledger (gross / eligible /
--             ineligible / reversal / net), the claim + reconciliation state.
-- Phase 17/18 finance_gstr2b â€” staging for the auto-drafted GSTR-2B lines the
--             purchase register is reconciled against.
--
-- The same objects are created idempotently at runtime by ensureGstInputSchema()
-- in lib/finance-ensure.ts, so existing databases self-heal without this file.
-- SAFE TO RE-RUN â€” every statement is guarded (CREATE ... IF NOT EXISTS or an
-- information_schema check).
-- =============================================================

-- ---- Phase 6/7: purchase bill line items ----------------------------------
CREATE TABLE IF NOT EXISTS purchase_bill_items (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  bill_id           VARCHAR(30) NOT NULL,
  line_no           INT NOT NULL DEFAULT 1,
  description       VARCHAR(500) DEFAULT NULL,
  hsn_sac           VARCHAR(20) DEFAULT NULL,
  quantity          DECIMAL(14,3) NOT NULL DEFAULT 0,
  unit              VARCHAR(20) DEFAULT NULL,
  rate              DECIMAL(14,4) NOT NULL DEFAULT 0,
  discount_type     VARCHAR(10) NOT NULL DEFAULT 'amount',
  discount_value    DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_amount   DECIMAL(14,2) NOT NULL DEFAULT 0,
  taxable_value     DECIMAL(14,2) NOT NULL DEFAULT 0,
  gst_rate          DECIMAL(6,2) NOT NULL DEFAULT 0,
  cgst_percent      DECIMAL(6,2) NOT NULL DEFAULT 0,
  cgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst_percent      DECIMAL(6,2) NOT NULL DEFAULT 0,
  sgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst_percent      DECIMAL(6,2) NOT NULL DEFAULT 0,
  igst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  cess_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  line_total        DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_eligibility   VARCHAR(20) NOT NULL DEFAULT 'Eligible',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pbi_bill (bill_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Phase 11-18: GST Input (ITC) register --------------------------------
CREATE TABLE IF NOT EXISTS finance_gst_input (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  gst_input_id          VARCHAR(30) NOT NULL,
  source                VARCHAR(40) NOT NULL DEFAULT 'Purchase Bill',
  source_bill_id        VARCHAR(30) NOT NULL,
  source_bill_ref       VARCHAR(60) DEFAULT NULL,
  bill_number           VARCHAR(120) DEFAULT NULL,
  bill_date             DATE DEFAULT NULL,
  period                VARCHAR(7) DEFAULT NULL,   -- YYYY-MM
  quarter               VARCHAR(7) DEFAULT NULL,   -- e.g. 2026-Q1
  financial_year        VARCHAR(12) DEFAULT NULL,
  vendor_id             VARCHAR(40) DEFAULT NULL,
  vendor_name           VARCHAR(255) DEFAULT NULL,
  vendor_gstin          VARCHAR(20) DEFAULT NULL,
  vendor_state          VARCHAR(120) DEFAULT NULL,
  vendor_state_code     VARCHAR(6) DEFAULT NULL,
  place_of_supply       VARCHAR(120) DEFAULT NULL,
  supply_type           VARCHAR(20) DEFAULT NULL,
  taxable_amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  gst_rate              DECIMAL(6,2) NOT NULL DEFAULT 0,
  cgst_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
  cess_amount           DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_gst             DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_eligible          TINYINT(1) NOT NULL DEFAULT 1,
  itc_section           VARCHAR(40) DEFAULT 'Input Services',
  itc_gross             DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_eligible_amount   DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_ineligible_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_reversal_amount   DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_net               DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_cgst              DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_sgst              DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_igst              DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_cess              DECIMAL(14,2) NOT NULL DEFAULT 0,
  itc_claimed           TINYINT(1) NOT NULL DEFAULT 0,
  claimed_period        VARCHAR(7) DEFAULT NULL,
  reconciliation_status VARCHAR(20) NOT NULL DEFAULT 'Unreconciled',
  gstr2b_reference      VARCHAR(120) DEFAULT NULL,
  gstr2b_taxable        DECIMAL(14,2) DEFAULT NULL,
  gstr2b_tax            DECIMAL(14,2) DEFAULT NULL,
  match_variance        DECIMAL(14,2) DEFAULT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'Available',
  narration             VARCHAR(500) DEFAULT NULL,
  created_by            INT DEFAULT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gin_source (source, source_bill_id),
  UNIQUE KEY uq_gin_id (gst_input_id),
  KEY idx_gin_period (period),
  KEY idx_gin_quarter (quarter),
  KEY idx_gin_vendor_gstin (vendor_gstin),
  KEY idx_gin_recon (reconciliation_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Phase 17/18: GSTR-2B staging (auto-populated from bills) --------------
CREATE TABLE IF NOT EXISTS finance_gstr2b (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  period            VARCHAR(7) NOT NULL,
  supplier_gstin    VARCHAR(20) DEFAULT NULL,
  supplier_name     VARCHAR(255) DEFAULT NULL,
  bill_number       VARCHAR(120) DEFAULT NULL,
  bill_date         DATE DEFAULT NULL,
  taxable_amount    DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  cess_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_tax         DECIMAL(14,2) NOT NULL DEFAULT 0,
  source            VARCHAR(30) NOT NULL DEFAULT 'Draft',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_g2b_period (period),
  KEY idx_g2b_gstin (supplier_gstin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Phase 10: effective-dated tax master ---------------------------------
DELIMITER $$
DROP PROCEDURE IF EXISTS `__gin_add_column` $$
CREATE PROCEDURE `__gin_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
     ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$
DELIMITER ;

CALL `__gin_add_column`('finance_tax_rates', 'effective_from', "effective_from DATE DEFAULT NULL");
CALL `__gin_add_column`('finance_tax_rates', 'effective_to',   "effective_to DATE DEFAULT NULL");
CALL `__gin_add_column`('finance_tax_rates', 'status',         "status VARCHAR(20) NOT NULL DEFAULT 'Active'");

DROP PROCEDURE IF EXISTS `__gin_add_column`;



-- FILE: 2026-10-02-purchase-bill-posting.sql
-- =============================================================
-- Purchase Bill accounting posting  (Phases 33â€“37, 104â€“107, 123, 148)
-- -------------------------------------------------------------
-- Wires Purchase Bills into the double-entry Journal + General Ledger:
--   * adds the posting linkage columns on purchase_bills (voucher_no,
--     reversal_voucher_no, posting_status, posted_at, posted_gross and the
--     frozen posted_snapshot used to unwind a reversal with the exact original
--     amounts);
--   * seeds the purchase-side Chart of Accounts (Purchases/Expenses, Input
--     CGST/SGST/IGST/Cess, Accounts Payable, TDS Payable) the posting engine
--     resolves by account_code.
--
-- The same columns + accounts are created idempotently at runtime by
-- ensurePurchaseBillColumns() (lib/finance-ensure.ts) and
-- ensurePurchasePostingAccounts() (lib/finance-accounts.ts), so existing
-- databases self-heal without this file. SAFE TO RE-RUN.
-- =============================================================

DELIMITER $$
DROP PROCEDURE IF EXISTS `__pbp_add_column` $$
CREATE PROCEDURE `__pbp_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$
DELIMITER ;

CALL `__pbp_add_column`('purchase_bills', 'voucher_no',          "voucher_no VARCHAR(40) DEFAULT NULL");
CALL `__pbp_add_column`('purchase_bills', 'reversal_voucher_no', "reversal_voucher_no VARCHAR(40) DEFAULT NULL");
CALL `__pbp_add_column`('purchase_bills', 'posting_status',      "posting_status VARCHAR(20) NOT NULL DEFAULT 'Unposted'");
CALL `__pbp_add_column`('purchase_bills', 'posted_at',           "posted_at DATETIME DEFAULT NULL");
CALL `__pbp_add_column`('purchase_bills', 'posted_gross',        "posted_gross DECIMAL(14,2) NOT NULL DEFAULT 0");
CALL `__pbp_add_column`('purchase_bills', 'posted_snapshot',     "posted_snapshot LONGTEXT DEFAULT NULL");

DROP PROCEDURE IF EXISTS `__pbp_add_column`;

-- ---- Purchase-side Chart of Accounts (only where the code is absent) -------
INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-PURCHASE', '5000', 'Purchases / Expenses', 'Expense', 'Direct Expense', 'Debit', 0, 0, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '5000');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-CGST-IN', '1410', 'Input CGST', 'Asset', 'Current Asset', 'Debit', 0, 1, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1410');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-SGST-IN', '1420', 'Input SGST', 'Asset', 'Current Asset', 'Debit', 0, 1, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1420');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-IGST-IN', '1430', 'Input IGST', 'Asset', 'Current Asset', 'Debit', 0, 1, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1430');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-CESS-IN', '1440', 'Input Cess', 'Asset', 'Current Asset', 'Debit', 0, 1, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '1440');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-AP', '2000', 'Accounts Payable', 'Liability', 'Current Liability', 'Credit', 0, 0, 0, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2000');

INSERT INTO chart_of_accounts
  (account_id, account_code, account_name, account_group, account_type, nature, bank_cash_account, gst_applicable, tds_applicable, active_status)
SELECT 'COA-TDS-PAY', '2150', 'TDS Payable', 'Liability', 'Duties & Taxes', 'Credit', 0, 0, 1, 'Active'
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = '2150');



-- FILE: 2026-10-03-upgrade-chart-of-accounts.sql
-- ---------------------------------------------------------------------------
-- Chart of Accounts master upgrade.
--
-- Adds the account-hierarchy / posting-configuration columns the upgraded
-- master needs and flags the posting-engine control accounts as system
-- accounts so they cannot be renamed, recoded, deactivated or deleted from the
-- UI. The columns are also self-healed at runtime by
-- lib/finance-ensure.ts â†’ ensureChartOfAccountsColumns() so this migration is
-- purely a record of the schema change; both are idempotent.
--
-- IMPORTANT: this preserves every existing linkage. Journal, General Ledger,
-- Purchase Bills, Sales Invoices, Expenses, Bank & Cash, GST, TDS and Reports
-- all resolve accounts by `account_id` / `account_code`, none of which change.
-- ---------------------------------------------------------------------------

ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS opening_balance_date DATE DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS financial_year VARCHAR(12) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_system TINYINT(1) NOT NULL DEFAULT 0;

-- Parent-account lookup index for the hierarchy view + dependency checks.
CREATE INDEX IF NOT EXISTS idx_coa_parent ON chart_of_accounts (parent_account_id);

-- Flag the posting-engine control accounts. Matched by the stable
-- account_code, so a company's own re-seeded account with the same code is
-- protected too. Codes mirror lib/finance-accounts.ts (ROLE_DEFAULT_CODE) and
-- the 2026-09-13 / 2026-10-02 seed migrations.
UPDATE chart_of_accounts
   SET is_system = 1
 WHERE account_code IN (
   '1200', -- Accounts Receivable
   '1450', -- TDS Receivable
   '4000', -- Sales Revenue
   '2110', '2120', '2130', '2140', -- Output CGST / SGST / IGST / Cess (GST Payable)
   '1000', -- Bank
   '1010', -- Cash
   '5000', -- Purchases / Expenses
   '1410', '1420', '1430', '1440', -- Input CGST / SGST / IGST / Cess (GST Input)
   '2000', -- Accounts Payable
   '2150', -- TDS Payable
   '5100', -- General Expenses
   '2200', -- Employee Reimbursements Payable
   '1460'  -- Employee Advances
 );



-- FILE: 2026-10-04-coa-opening-balances-per-fy.sql
-- ---------------------------------------------------------------------------
-- Per-financial-year opening balances for the Chart of Accounts.
--
-- Adds a dedicated store so an account can carry a distinct opening balance for
-- every financial year, each projected into its own balanced Journal + General
-- Ledger voucher (contra on the Opening Balance Equity head, code 3900). One
-- row per (account_id, financial_year); the posting tracking columns key each
-- year's voucher so it posts, re-posts and reverses independently and
-- idempotently.
--
-- The chart_of_accounts.opening_balance / opening_balance_type /
-- opening_balance_date / financial_year columns are UNCHANGED and remain the
-- account's PRIMARY year â€” the value shown in the master list, the summary KPI,
-- the exports and the 360Â° view. lib/finance-opening-balance.ts mirrors that
-- primary entry into this table and back on every sync so the two never drift.
--
-- This table is also created and backfilled at runtime by
-- lib/finance-opening-balance.ts -> ensureOpeningBalanceTable(), so this
-- migration is purely a record of the schema change; both are idempotent and
-- preserve every existing linkage (Journal, General Ledger, Purchase Bills,
-- Sales Invoices, Expenses, Bank & Cash, GST, TDS, Reports).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS coa_opening_balances (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id VARCHAR(40) NOT NULL,
  financial_year VARCHAR(12) NOT NULL,
  opening_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
  opening_balance_type VARCHAR(10) DEFAULT NULL,
  opening_balance_date DATE DEFAULT NULL,
  ob_voucher_no VARCHAR(40) DEFAULT NULL,
  ob_posted_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  ob_posted_side VARCHAR(10) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_coa_ob_year (account_id, financial_year),
  KEY idx_coa_ob_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill the legacy single opening balance held on chart_of_accounts into its
-- financial-year row, carrying the posted-voucher state so it is never
-- re-posted. Rows whose financial_year is blank are backfilled at runtime
-- (where the year can be derived from the opening-balance date).
INSERT INTO coa_opening_balances
    (account_id, financial_year, opening_balance, opening_balance_type,
     opening_balance_date, ob_voucher_no, ob_posted_amount, ob_posted_side)
SELECT c.account_id, c.financial_year, c.opening_balance, c.opening_balance_type,
       c.opening_balance_date, c.ob_voucher_no, c.ob_posted_amount, c.ob_posted_side
  FROM chart_of_accounts c
 WHERE (c.opening_balance <> 0 OR (c.ob_voucher_no IS NOT NULL AND c.ob_voucher_no <> ''))
   AND c.financial_year IS NOT NULL AND c.financial_year <> ''
   AND c.account_code <> '3900'
ON DUPLICATE KEY UPDATE account_id = coa_opening_balances.account_id;



-- FILE: 2026-10-05-finance-capital-equity.sql
-- =====================================================================
-- Finance :: Capital & Equity
-- Mirrors the schema created at runtime by ensureRegisterModuleTables()
-- (lib/finance-ensure.ts). Safe to run on a fresh or existing database.
-- MySQL 8 / InnoDB / utf8mb4.
-- =====================================================================

CREATE TABLE IF NOT EXISTS capital_equity (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  entry_id            VARCHAR(30) NOT NULL,
  entry_type          VARCHAR(60) DEFAULT NULL,
  contributor_name    VARCHAR(255) DEFAULT NULL,
  entry_date          DATE DEFAULT NULL,
  financial_year      VARCHAR(12) DEFAULT NULL,
  amount              DECIMAL(16,2) NOT NULL DEFAULT 0,
  mode                VARCHAR(40) DEFAULT NULL,
  transfer_source     VARCHAR(60) DEFAULT NULL,
  direction           VARCHAR(20) DEFAULT NULL,
  instrument          VARCHAR(120) DEFAULT NULL,
  status              VARCHAR(30) NOT NULL DEFAULT 'Active',
  notes               TEXT DEFAULT NULL,
  -- shared register posting columns
  posting_status      VARCHAR(20) NOT NULL DEFAULT 'unposted',
  voucher_no          VARCHAR(40) DEFAULT NULL,
  reversal_voucher_no VARCHAR(40) DEFAULT NULL,
  posted_amount       DECIMAL(16,2) DEFAULT NULL,
  posted_snapshot     JSON DEFAULT NULL,
  posted_at           DATETIME DEFAULT NULL,
  -- audit
  created_by          INT DEFAULT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cap_id (entry_id),
  KEY idx_cap_fy (financial_year),
  KEY idx_cap_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-10-05-finance-investments.sql
-- =====================================================================
-- Finance / Investments module
-- Mirrors the runtime schema created by ensureRegisterModuleTables()
-- in lib/finance-ensure.ts. Idempotent: safe on fresh or existing DBs.
-- MySQL 8 / InnoDB / utf8mb4.
-- =====================================================================

CREATE TABLE IF NOT EXISTS investments (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  investment_id         VARCHAR(30) NOT NULL,
  investment_name       VARCHAR(255) DEFAULT NULL,
  investment_type       VARCHAR(60) DEFAULT NULL,
  acquisition_date      DATE DEFAULT NULL,
  financial_year        VARCHAR(12) DEFAULT NULL,
  amount                DECIMAL(16,2) NOT NULL DEFAULT 0,
  funding_source        VARCHAR(40) DEFAULT NULL,
  units                 DECIMAL(16,4) NOT NULL DEFAULT 0,
  expected_return_rate  DECIMAL(6,2) NOT NULL DEFAULT 0,
  maturity_date         DATE DEFAULT NULL,
  current_value         DECIMAL(16,2) NOT NULL DEFAULT 0,
  status                VARCHAR(30) NOT NULL DEFAULT 'Active',
  notes                 TEXT DEFAULT NULL,
  -- shared posting columns (register -> Journal -> GL engine)
  posting_status        VARCHAR(20) NOT NULL DEFAULT 'Unposted',
  voucher_no            VARCHAR(30) DEFAULT NULL,
  reversal_voucher_no   VARCHAR(30) DEFAULT NULL,
  posted_amount         DECIMAL(16,2) NOT NULL DEFAULT 0,
  posted_snapshot       LONGTEXT DEFAULT NULL,
  posted_at             DATETIME DEFAULT NULL,
  created_by            INT DEFAULT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inv_id (investment_id),
  KEY idx_inv_fy (financial_year),
  KEY idx_inv_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-10-05-finance-loans-advances.sql
-- =====================================================================
-- Finance > Loans & Advances sub-module â€” full schema
-- ---------------------------------------------------------------------
-- Mirrors the self-healing schema the app builds at runtime:
--   * base `loans_advances` table      -> lib/finance-ensure.ensureRegisterModuleTables
--   * Phase-4 extra columns            -> lib/finance-ensure.ensureLoansAdvancesColumns
--   * loans_advances_schedule          -> per-installment amortisation schedule
--
-- Idempotent: safe to run on a fresh DB or an existing one (uses
-- CREATE TABLE IF NOT EXISTS). All accounting still flows Journal -> GL
-- through the shared posting engine (lib/finance-register-posting); these
-- tables only hold the loan master and its repayment schedule.
-- MySQL 8 / InnoDB / utf8mb4.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Loan / advance master (base + Phase-4 columns merged into one definition)
--    `direction` distinguishes a loan/advance GIVEN (asset/receivable) from
--    one TAKEN (liability/payable); the posting engine keys off it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans_advances (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  loan_id                VARCHAR(30)  NOT NULL,
  party_name             VARCHAR(255) DEFAULT NULL,
  party_type             VARCHAR(40)  DEFAULT NULL,
  direction              VARCHAR(40)  DEFAULT NULL,
  principal              DECIMAL(16,2) NOT NULL DEFAULT 0,
  interest_rate          DECIMAL(6,2)  NOT NULL DEFAULT 0,
  disbursement_date      DATE         DEFAULT NULL,
  financial_year         VARCHAR(12)  DEFAULT NULL,
  funding_source         VARCHAR(40)  DEFAULT NULL,
  repayment_terms        VARCHAR(255) DEFAULT NULL,
  outstanding_amount     DECIMAL(16,2) NOT NULL DEFAULT 0,
  status                 VARCHAR(30)  NOT NULL DEFAULT 'Active',
  notes                  TEXT         DEFAULT NULL,

  -- Posting columns (shared voucher engine)
  posting_status         VARCHAR(20)  NOT NULL DEFAULT 'Unposted',
  voucher_no             VARCHAR(30)  DEFAULT NULL,
  reversal_voucher_no    VARCHAR(30)  DEFAULT NULL,
  posted_amount          DECIMAL(16,2) NOT NULL DEFAULT 0,
  posted_snapshot        LONGTEXT     DEFAULT NULL,
  posted_at              DATETIME     DEFAULT NULL,

  -- Phase-4 additional columns (ensureLoansAdvancesColumns)
  loan_type              VARCHAR(40)  DEFAULT NULL,
  party_id               VARCHAR(40)  DEFAULT NULL,
  interest_method        VARCHAR(30)  DEFAULT NULL,
  start_date             DATE         DEFAULT NULL,
  end_date               DATE         DEFAULT NULL,
  tenure_months          INT          NOT NULL DEFAULT 0,
  installment_frequency  VARCHAR(20)  DEFAULT NULL,
  emi_amount             DECIMAL(16,2) NOT NULL DEFAULT 0,
  interest_total         DECIMAL(16,2) NOT NULL DEFAULT 0,
  total_payable          DECIMAL(16,2) NOT NULL DEFAULT 0,
  outstanding_principal  DECIMAL(16,2) NOT NULL DEFAULT 0,
  outstanding_interest   DECIMAL(16,2) NOT NULL DEFAULT 0,
  purpose                VARCHAR(255) DEFAULT NULL,
  bank_account_id        VARCHAR(40)  DEFAULT NULL,
  bank_account_name      VARCHAR(190) DEFAULT NULL,
  document_url           TEXT         DEFAULT NULL,

  created_by             INT          DEFAULT NULL,
  created_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_la_id (loan_id),
  KEY idx_la_fy (financial_year),
  KEY idx_la_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 2. Per-installment amortisation schedule
--    One row per loan + installment. Regenerated wholesale whenever the
--    loan's principal / rate / tenure / method / start date change, and
--    dropped on loan delete (see lib/finance-crud AFTER_DELETE hook).
--    No direct accounting impact â€” a repayment plan / tracking log.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans_advances_schedule (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  loan_id              VARCHAR(30)  NOT NULL,
  installment_no       INT          NOT NULL DEFAULT 0,
  due_date             DATE         DEFAULT NULL,
  opening_balance      DECIMAL(16,2) NOT NULL DEFAULT 0,
  emi                  DECIMAL(16,2) NOT NULL DEFAULT 0,
  principal_component  DECIMAL(16,2) NOT NULL DEFAULT 0,
  interest_component   DECIMAL(16,2) NOT NULL DEFAULT 0,
  closing_balance      DECIMAL(16,2) NOT NULL DEFAULT 0,
  status               VARCHAR(20)  NOT NULL DEFAULT 'Due',
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_las_loan (loan_id),
  KEY idx_las_due (due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-10-05-finance-provisions-accruals.sql
-- =============================================================================
-- Finance > Provisions & Accruals
-- =============================================================================
-- Mirrors the schema created at runtime by ensureRegisterModuleTables()
-- (lib/finance-ensure.ts). Idempotent: safe to run on a fresh or existing DB.
-- MySQL 8 / InnoDB / utf8mb4.
--
-- provisions_accruals is a transactional register table. Its accounting is
-- posted through the shared register -> Journal -> General Ledger engine; the
-- posting_* columns are written only by that posting engine.
-- =============================================================================

CREATE TABLE IF NOT EXISTS provisions_accruals (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  provision_id        VARCHAR(30) NOT NULL,
  provision_name      VARCHAR(255) DEFAULT NULL,
  provision_type      VARCHAR(60) DEFAULT NULL,
  provision_date      DATE DEFAULT NULL,
  financial_year      VARCHAR(12) DEFAULT NULL,
  amount              DECIMAL(16,2) NOT NULL DEFAULT 0,
  related_party       VARCHAR(255) DEFAULT NULL,
  status              VARCHAR(30) NOT NULL DEFAULT 'Open',
  notes               TEXT DEFAULT NULL,

  -- Shared posting columns (written only by the register posting engine)
  posting_status      VARCHAR(20) NOT NULL DEFAULT 'Unposted',
  voucher_no          VARCHAR(30) DEFAULT NULL,
  reversal_voucher_no VARCHAR(30) DEFAULT NULL,
  posted_amount       DECIMAL(16,2) NOT NULL DEFAULT 0,
  posted_snapshot     LONGTEXT DEFAULT NULL,
  posted_at           DATETIME DEFAULT NULL,

  -- Audit
  created_by          INT DEFAULT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_prv_id (provision_id),
  KEY idx_prv_fy (financial_year),
  KEY idx_prv_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-10-05-finance-related-parties.sql
-- Finance :: Related Parties (disclosure master)
-- Mirrors the self-healing definition in lib/finance-ensure.ts so the table
-- exists on a clean database without waiting for the first runtime ensure().
-- Related Parties is a plain master (AS 18 / Ind AS 24 disclosure) and never
-- posts to the register, so it carries no posting columns.

CREATE TABLE IF NOT EXISTS related_parties (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  party_id               VARCHAR(30) NOT NULL,
  party_name             VARCHAR(255) DEFAULT NULL,
  relationship           VARCHAR(80) DEFAULT NULL,
  pan                    VARCHAR(15) DEFAULT NULL,
  gstin                  VARCHAR(20) DEFAULT NULL,
  nature_of_relationship VARCHAR(255) DEFAULT NULL,
  effective_from         DATE DEFAULT NULL,
  effective_to           DATE DEFAULT NULL,
  opening_balance        DECIMAL(16,2) NOT NULL DEFAULT 0,
  contact_person         VARCHAR(190) DEFAULT NULL,
  email                  VARCHAR(190) DEFAULT NULL,
  phone                  VARCHAR(40) DEFAULT NULL,
  address                TEXT DEFAULT NULL,
  status                 VARCHAR(30) NOT NULL DEFAULT 'Active',
  notes                  TEXT DEFAULT NULL,
  created_by             INT DEFAULT NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rp_id (party_id),
  KEY idx_rp_relationship (relationship),
  KEY idx_rp_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-10-06-recruit-integrations.sql
-- ===========================================================================
-- Recruitment cross-module integrations
--
-- Wires the standalone config-driven Job Requisitions onto the operational
-- worksuite recruit_* pipeline and onto the HR employee master. Three
-- genuinely-missing links are added here:
--
--   1. Requisition -> Job link + approval workflow
--        recruitment_requisitions gains approval + linked-job columns, and
--        recruit_jobs gains a back-reference to the requisition it was raised
--        from. Jobs can only be created from an APPROVED requisition, and the
--        requisition auto-fills / auto-closes as the linked job hires.
--
--   2. Candidate -> HR Employee handoff
--        recruit_offers / recruit_applications remember the hr_employees record
--        they were converted into, so an accepted candidate becomes an employee
--        exactly once.
--
--   3. Pre-joining / BGV / Reference checks
--        Three new tables keyed on the application, so verification and
--        pre-joining readiness live alongside the pipeline.
--
-- All statements are idempotent (IF NOT EXISTS) and safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Requisition -> Job link + approval workflow
-- ---------------------------------------------------------------------------
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(40) NOT NULL DEFAULT 'draft';
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS approved_by INT UNSIGNED DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS approved_by_name VARCHAR(190) DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS approved_at DATETIME DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS approval_notes VARCHAR(500) DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS linked_job_id VARCHAR(40) DEFAULT NULL;

-- Back-reference on the operational job so we can roll hires up to the
-- requisition and close it when its headcount is filled.
ALTER TABLE recruit_jobs
  ADD COLUMN IF NOT EXISTS requisition_id VARCHAR(40) DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- 2. Candidate -> HR Employee handoff
-- ---------------------------------------------------------------------------
ALTER TABLE recruit_offers
  ADD COLUMN IF NOT EXISTS hired_employee_id VARCHAR(50) DEFAULT NULL;
ALTER TABLE recruit_applications
  ADD COLUMN IF NOT EXISTS hired_employee_id VARCHAR(50) DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- 3. Pre-joining / Background Verification / Reference checks
-- ---------------------------------------------------------------------------

-- 3a. Background verification checks (one row per check per candidate).
CREATE TABLE IF NOT EXISTS recruit_bgv_checks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bgv_id VARCHAR(40) NOT NULL,
  application_id VARCHAR(40) DEFAULT NULL,
  candidate_name VARCHAR(190) DEFAULT NULL,
  check_type VARCHAR(60) NOT NULL DEFAULT 'Identity',
  agency VARCHAR(190) DEFAULT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  result VARCHAR(40) DEFAULT NULL,
  initiated_at DATE DEFAULT NULL,
  completed_at DATE DEFAULT NULL,
  remarks TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bgv_id (bgv_id),
  KEY idx_bgv_app (application_id),
  KEY idx_bgv_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3b. Reference checks (one row per referee per candidate).
CREATE TABLE IF NOT EXISTS recruit_reference_checks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference_id VARCHAR(40) NOT NULL,
  application_id VARCHAR(40) DEFAULT NULL,
  candidate_name VARCHAR(190) DEFAULT NULL,
  referee_name VARCHAR(190) DEFAULT NULL,
  relationship VARCHAR(120) DEFAULT NULL,
  company VARCHAR(190) DEFAULT NULL,
  contact VARCHAR(190) DEFAULT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  rating INT NOT NULL DEFAULT 0,
  feedback TEXT,
  checked_at DATE DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reference_id (reference_id),
  KEY idx_ref_app (application_id),
  KEY idx_ref_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3c. Pre-joining checklist tasks (one row per task per candidate).
CREATE TABLE IF NOT EXISTS recruit_prejoining_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id VARCHAR(40) NOT NULL,
  application_id VARCHAR(40) DEFAULT NULL,
  candidate_name VARCHAR(190) DEFAULT NULL,
  task VARCHAR(255) NOT NULL,
  category VARCHAR(60) DEFAULT NULL,
  owner VARCHAR(190) DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  remarks TEXT,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_prejoin_task_id (task_id),
  KEY idx_prejoin_app (application_id),
  KEY idx_prejoin_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-10-07-recruit-unification.sql
-- ===========================================================================
-- Recruitment unification: one candidate spine across both systems
--
-- The Recruitment module historically had two parallel worlds:
--
--   * The operational worksuite pipeline (recruit_jobs -> recruit_applications
--     -> recruit_offers -> hr_employees, plus recruit_interviews / recruit_bgv_
--     checks / recruit_reference_checks / recruit_prejoining_tasks), keyed on
--     recruit_applications.application_id.
--
--   * The config-driven Recruitment modules (recruitment_candidates a.k.a.
--     "Candidate Master", recruitment_screening, recruitment_interviews,
--     recruitment_assessments, recruitment_selections, recruitment_interview_
--     feedback, recruitment_background_verification, recruitment_reference_
--     checks, recruitment_pre_joining), keyed on a free-text candidate_id /
--     candidate_name and NOT linked to the operational application.
--
-- This migration wires the two together with the canonical person being the
-- Candidate Master (recruitment_candidates), while every stage record links to
-- the operational application via application_id:
--
--   recruit_applications.candidate_master_id  -> recruitment_candidates.candidate_id
--   recruitment_candidates.application_id      -> recruit_applications.application_id (latest)
--   <stage tables>.application_id              -> recruit_applications.application_id
--
-- All statements are idempotent (MariaDB IF NOT EXISTS) and safe to re-run.
-- The application self-heals the same schema at runtime
-- (lib/recruit-unification-db.ts -> ensureUnificationSchema), so applying this
-- file is optional but recommended.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Canonical person <-> operational application cross-links
-- ---------------------------------------------------------------------------
ALTER TABLE recruit_applications
  ADD COLUMN IF NOT EXISTS candidate_master_id VARCHAR(191) DEFAULT NULL;
ALTER TABLE recruit_applications
  ADD INDEX IF NOT EXISTS idx_app_candidate_master (candidate_master_id);

ALTER TABLE recruitment_candidates
  ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruitment_candidates
  ADD COLUMN IF NOT EXISTS norm_email VARCHAR(255) DEFAULT NULL;
ALTER TABLE recruitment_candidates
  ADD COLUMN IF NOT EXISTS norm_phone VARCHAR(20) DEFAULT NULL;
ALTER TABLE recruitment_candidates
  ADD INDEX IF NOT EXISTS idx_cand_application (application_id);
ALTER TABLE recruitment_candidates
  ADD INDEX IF NOT EXISTS idx_cand_norm_email (norm_email);
ALTER TABLE recruitment_candidates
  ADD INDEX IF NOT EXISTS idx_cand_norm_phone (norm_phone);

-- ---------------------------------------------------------------------------
-- Stage tables gain an application_id link back to the operational pipeline.
-- (They already carry candidate_id / candidate_name from their module config.)
--
-- These config-driven tables are created lazily by their module and may not
-- exist yet in every database. Plain `ALTER TABLE` has no table-level
-- IF EXISTS guard, so a missing table (e.g. recruitment_interview_feedback)
-- would abort the whole import. We guard each one with a helper procedure that
-- only alters the table when it actually exists â€” mirroring the runtime
-- self-heal (ensureUnificationSchema), which skips tables that aren't present.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS _recruit_link_stage_table;
DELIMITER $$
CREATE PROCEDURE _recruit_link_stage_table(IN p_table VARCHAR(64), IN p_index VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = p_table
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table,
      '` ADD COLUMN IF NOT EXISTS application_id VARCHAR(40) DEFAULT NULL');
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

    SET @ddl = CONCAT('ALTER TABLE `', p_table,
      '` ADD INDEX IF NOT EXISTS ', p_index, ' (application_id)');
    PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL _recruit_link_stage_table('recruitment_screening', 'idx_scr_application');
CALL _recruit_link_stage_table('recruitment_interviews', 'idx_rint_application');
CALL _recruit_link_stage_table('recruitment_assessments', 'idx_asm_application');
CALL _recruit_link_stage_table('recruitment_selections', 'idx_sel_application');
CALL _recruit_link_stage_table('recruitment_interview_feedback', 'idx_ifb_application');
CALL _recruit_link_stage_table('recruitment_background_verification', 'idx_rbgv_application');
CALL _recruit_link_stage_table('recruitment_reference_checks', 'idx_rref_application');
CALL _recruit_link_stage_table('recruitment_pre_joining', 'idx_prj_application');

DROP PROCEDURE IF EXISTS _recruit_link_stage_table;



-- FILE: 2026-10-08-recruit-candidate-master-consolidation.sql
-- ===========================================================================
-- Recruitment Phase 5: collapse the parallel candidate profile store
--
-- Background
-- ----------
-- The Recruitment module previously wrote every applicant into TWO independent
-- profile tables:
--
--   * recruit_candidates       -- the old "Candidate Database" profile store,
--                                 written on every application via
--                                 upsertCandidateProfile()
--   * recruitment_candidates   -- the canonical "Candidate Master" from the
--                                 unification layer
--
-- That is exactly the "same candidate copied into multiple independent records"
-- problem. The application code no longer writes or reads recruit_candidates:
--   - createApplication() now only calls linkApplicationToMaster()
--   - /api/recruit/candidates now reads listCandidateDatabase(), which is
--     backed by recruitment_candidates (Candidate Master)
--
-- This migration folds any people who exist ONLY in the legacy
-- recruit_candidates table into the Candidate Master so nobody is lost, then
-- retires the legacy table. It is idempotent and safe to re-run.
--
-- NOTE: run 2026-10-07-recruit-unification.sql FIRST â€” it creates the
-- recruitment_candidates columns (norm_email, norm_phone, application_id) this
-- migration relies on.
-- ===========================================================================

-- Guard: if the legacy table was never created on this database, there is
-- nothing to consolidate. The statements below are written so that a missing
-- recruit_candidates table simply makes them no-ops when wrapped by your
-- runner; if your runner stops on the first missing-table error, you can skip
-- this file entirely on that database.

-- ---------------------------------------------------------------------------
-- 1. Backfill Candidate Master from legacy profiles that have no match yet.
--    A legacy profile matches an existing Master row when they share a
--    normalized email OR normalized phone. Only truly-new people are inserted.
-- ---------------------------------------------------------------------------
INSERT INTO recruitment_candidates
  (candidate_id, candidate_name, email, mobile, norm_email, norm_phone,
   current_location, current_company, experience, application_date, created_at)
SELECT
  CONCAT('CANDLEG-', lc.id)                              AS candidate_id,
  COALESCE(NULLIF(lc.candidate_name, ''), 'Candidate')  AS candidate_name,
  lc.email,
  lc.phone,
  NULLIF(LOWER(TRIM(lc.email)), '')                     AS norm_email,
  CASE
    WHEN lc.phone IS NULL OR REGEXP_REPLACE(lc.phone, '[^0-9]', '') = '' THEN NULL
    WHEN CHAR_LENGTH(REGEXP_REPLACE(lc.phone, '[^0-9]', '')) > 10
      THEN RIGHT(REGEXP_REPLACE(lc.phone, '[^0-9]', ''), 10)
    ELSE REGEXP_REPLACE(lc.phone, '[^0-9]', '')
  END                                                   AS norm_phone,
  lc.location,
  lc.current_company,
  lc.experience,
  lc.last_applied,
  COALESCE(lc.created_at, NOW())
FROM recruit_candidates lc
WHERE NOT EXISTS (
  SELECT 1 FROM recruitment_candidates m
  WHERE (
      m.norm_email IS NOT NULL
      AND m.norm_email = NULLIF(LOWER(TRIM(lc.email)), '')
    )
    OR (
      m.norm_phone IS NOT NULL
      AND m.norm_phone = CASE
        WHEN lc.phone IS NULL OR REGEXP_REPLACE(lc.phone, '[^0-9]', '') = '' THEN NULL
        WHEN CHAR_LENGTH(REGEXP_REPLACE(lc.phone, '[^0-9]', '')) > 10
          THEN RIGHT(REGEXP_REPLACE(lc.phone, '[^0-9]', ''), 10)
        ELSE REGEXP_REPLACE(lc.phone, '[^0-9]', '')
      END
    )
)
-- Avoid double-inserting the same legacy person on a re-run.
AND NOT EXISTS (
  SELECT 1 FROM recruitment_candidates m2
  WHERE m2.candidate_id = CONCAT('CANDLEG-', lc.id)
);

-- ---------------------------------------------------------------------------
-- 2. Enrich existing Master rows with any non-empty fields that only the
--    legacy profile had (never overwrite an existing Master value).
-- ---------------------------------------------------------------------------
UPDATE recruitment_candidates m
JOIN recruit_candidates lc
  ON (
       m.norm_email IS NOT NULL
       AND m.norm_email = NULLIF(LOWER(TRIM(lc.email)), '')
     )
  OR (
       m.norm_phone IS NOT NULL
       AND m.norm_phone = CASE
         WHEN lc.phone IS NULL OR REGEXP_REPLACE(lc.phone, '[^0-9]', '') = '' THEN NULL
         WHEN CHAR_LENGTH(REGEXP_REPLACE(lc.phone, '[^0-9]', '')) > 10
           THEN RIGHT(REGEXP_REPLACE(lc.phone, '[^0-9]', ''), 10)
         ELSE REGEXP_REPLACE(lc.phone, '[^0-9]', '')
       END
     )
SET
  m.current_location = COALESCE(NULLIF(m.current_location, ''), NULLIF(lc.location, '')),
  m.current_company  = COALESCE(NULLIF(m.current_company, ''),  NULLIF(lc.current_company, '')),
  m.experience       = COALESCE(NULLIF(m.experience, ''),       NULLIF(lc.experience, '')),
  m.mobile           = COALESCE(NULLIF(m.mobile, ''),           NULLIF(lc.phone, '')),
  m.email            = COALESCE(NULLIF(m.email, ''),            NULLIF(lc.email, ''));

-- ---------------------------------------------------------------------------
-- 3. Retire the legacy table. Kept as a rename (not DROP) so the data is
--    recoverable; drop the archived copy once you've verified the Candidate
--    Database page looks correct.
-- ---------------------------------------------------------------------------
RENAME TABLE recruit_candidates TO recruit_candidates_legacy_20261008;
-- After verification you may run:
--   DROP TABLE IF EXISTS recruit_candidates_legacy_20261008;



-- FILE: 2026-10-09-recruit-unified-flow.sql
-- ===========================================================================
-- Recruitment unified flow â€” Phases 6-10 schema completion
--
-- Completes the single Requisition -> Approval -> Job -> Application spine so
-- there is exactly ONE recruitment data flow (requisition-hiring is canonical;
-- the old config-driven Job Requisitions page now redirects onto it).
--
-- Adds the genuinely-missing columns the spec calls for:
--
--   * Requisition approval audit trail:
--       Submitted By/At, Rejected By/At, Rejection Reason (Approved By/At and
--       approval_notes already exist from 2026-10-06). Plus an explicit
--       designation so it can flow through to the Job.
--
--   * Job: designation + hiring_manager (recruiter already exists).
--
--   * Application: requisition_id + campaign + recruiter, so every application
--       â€” internal or from the Career Site â€” enters the same pipeline and rolls
--       up to its requisition/campaign.
--
-- All statements are idempotent (IF NOT EXISTS) and safe to re-run. The
-- application layer also self-heals these via ensureUnifiedFlowSchema() /
-- ensureUnificationSchema(), so the code never crashes on a not-yet-migrated DB.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Requisition approval audit trail + designation
-- ---------------------------------------------------------------------------
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS submitted_by INT UNSIGNED DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS submitted_by_name VARCHAR(190) DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS submitted_at DATETIME DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS rejected_by INT UNSIGNED DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS rejected_by_name VARCHAR(190) DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS rejected_at DATETIME DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(500) DEFAULT NULL;
ALTER TABLE recruitment_requisitions
  ADD COLUMN IF NOT EXISTS designation VARCHAR(190) DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- Job: designation + hiring manager (recruiter already present)
-- ---------------------------------------------------------------------------
ALTER TABLE recruit_jobs
  ADD COLUMN IF NOT EXISTS designation VARCHAR(190) DEFAULT NULL;
ALTER TABLE recruit_jobs
  ADD COLUMN IF NOT EXISTS hiring_manager VARCHAR(190) DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- Application: requisition link + campaign + recruiter
-- ---------------------------------------------------------------------------
ALTER TABLE recruit_applications
  ADD COLUMN IF NOT EXISTS requisition_id VARCHAR(40) DEFAULT NULL;
ALTER TABLE recruit_applications
  ADD COLUMN IF NOT EXISTS campaign VARCHAR(190) DEFAULT NULL;
ALTER TABLE recruit_applications
  ADD COLUMN IF NOT EXISTS recruiter VARCHAR(190) DEFAULT NULL;
ALTER TABLE recruit_applications
  ADD INDEX IF NOT EXISTS idx_jap_requisition (requisition_id);



-- FILE: 2026-10-10-operations-work-management-links.sql
-- =============================================================================
-- Operations Module â€” Work Management connective fields
-- -----------------------------------------------------------------------------
-- Completes the Work Management group by linking Tasks and Work Orders to the
-- existing Operations entities (Client, Resource, Milestone, Task) instead of
-- leaving them as standalone records. No new masters or pipelines are created â€”
-- these are plain reference columns that point at existing operations_* rows.
--
-- Safe to run more than once: every column uses ADD COLUMN IF NOT EXISTS and no
-- existing column or row is modified, so current Tasks / Work Orders data and
-- pages are fully preserved.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tasks â€” link to Client, Resource and Milestone (Project, assignee/reporter,
-- priority, dates and status already exist).
-- ---------------------------------------------------------------------------
ALTER TABLE operations_tasks
  ADD COLUMN IF NOT EXISTS client_name VARCHAR(255) DEFAULT NULL AFTER project_name,
  ADD COLUMN IF NOT EXISTS resource_id VARCHAR(191) DEFAULT NULL AFTER assigned_to,
  ADD COLUMN IF NOT EXISTS resource_name VARCHAR(255) DEFAULT NULL AFTER resource_id,
  ADD COLUMN IF NOT EXISTS milestone_id VARCHAR(191) DEFAULT NULL AFTER resource_name,
  ADD COLUMN IF NOT EXISTS milestone_name VARCHAR(255) DEFAULT NULL AFTER milestone_id;

-- ---------------------------------------------------------------------------
-- Work Orders â€” link to a Task and a Resource, plus free-form Instructions
-- (Project, Client, assignee, requester, dates and status already exist).
-- ---------------------------------------------------------------------------
ALTER TABLE operations_work_orders
  ADD COLUMN IF NOT EXISTS task_id VARCHAR(191) DEFAULT NULL AFTER project_id,
  ADD COLUMN IF NOT EXISTS resource_id VARCHAR(191) DEFAULT NULL AFTER assigned_to,
  ADD COLUMN IF NOT EXISTS resource_name VARCHAR(255) DEFAULT NULL AFTER resource_id,
  ADD COLUMN IF NOT EXISTS instructions TEXT DEFAULT NULL AFTER description;



-- FILE: 2026-10-11-upgrade-notice-board.sql
-- Notice Board upgrade â€” complete, secure, automated lifecycle.
-- This migration is mirrored (and self-healed) at runtime by
-- lib/notice-board.ts -> ensureNoticeSchema(), so the app works even on
-- installs where this file has not been applied yet. Kept here for fresh
-- installs and documentation. All statements are idempotent.

-- --------------------------------------------------------------------------
-- notices: extend the existing table (heading/description preserved).
-- --------------------------------------------------------------------------
ALTER TABLE notices
  ADD COLUMN IF NOT EXISTS notice_code VARCHAR(30) NULL AFTER id,
  ADD COLUMN IF NOT EXISTS category VARCHAR(80) NOT NULL DEFAULT 'General' AFTER description,
  ADD COLUMN IF NOT EXISTS priority ENUM('normal','important','urgent') NOT NULL DEFAULT 'normal' AFTER category,
  ADD COLUMN IF NOT EXISTS status ENUM('draft','scheduled','published','expired','archived','cancelled') NOT NULL DEFAULT 'draft' AFTER priority,
  ADD COLUMN IF NOT EXISTS audience_type ENUM('all','department','designation','location','employment_type','employees') NOT NULL DEFAULT 'all' AFTER to_type,
  ADD COLUMN IF NOT EXISTS audience_config JSON NULL AFTER audience_type,
  ADD COLUMN IF NOT EXISTS include_inactive TINYINT(1) NOT NULL DEFAULT 0 AFTER audience_config,
  ADD COLUMN IF NOT EXISTS start_date DATE NULL AFTER include_inactive,
  ADD COLUMN IF NOT EXISTS end_date DATE NULL AFTER start_date,
  ADD COLUMN IF NOT EXISTS publish_date DATETIME NULL AFTER end_date,
  ADD COLUMN IF NOT EXISTS published_at DATETIME NULL AFTER publish_date,
  ADD COLUMN IF NOT EXISTS expired_at DATETIME NULL AFTER published_at,
  ADD COLUMN IF NOT EXISTS acknowledgement_required TINYINT(1) NOT NULL DEFAULT 0 AFTER expired_at,
  ADD COLUMN IF NOT EXISTS notify_in_app TINYINT(1) NOT NULL DEFAULT 1 AFTER acknowledgement_required,
  ADD COLUMN IF NOT EXISTS notify_email TINYINT(1) NOT NULL DEFAULT 0 AFTER notify_in_app,
  ADD COLUMN IF NOT EXISTS pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER notify_email,
  ADD COLUMN IF NOT EXISTS keep_pinned_after_expiry TINYINT(1) NOT NULL DEFAULT 0 AFTER pinned,
  ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(500) NULL AFTER keep_pinned_after_expiry,
  ADD COLUMN IF NOT EXISTS effective_date DATE NULL AFTER cancel_reason,
  ADD COLUMN IF NOT EXISTS review_date DATE NULL AFTER effective_date,
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1 AFTER review_date,
  ADD COLUMN IF NOT EXISTS recipients_finalized TINYINT(1) NOT NULL DEFAULT 0 AFTER version,
  ADD COLUMN IF NOT EXISTS updated_by INT NULL AFTER recipients_finalized,
  ADD COLUMN IF NOT EXISTS updated_by_name VARCHAR(150) NULL AFTER updated_by;

-- Legacy rows were live announcements â€” keep them visible.
UPDATE notices SET status = 'published' WHERE status = 'draft' AND created_at < (NOW() - INTERVAL 1 MINUTE) AND published_at IS NULL;
UPDATE notices SET published_at = created_at WHERE status = 'published' AND published_at IS NULL;
UPDATE notices SET audience_type = 'department' WHERE (audience_type = 'all') AND department IS NOT NULL AND department <> '';
UPDATE notices SET notice_code = CONCAT('NOT-', YEAR(created_at), '-', LPAD(id, 6, '0')) WHERE notice_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_notice_code ON notices (notice_code);
CREATE INDEX IF NOT EXISTS idx_notices_status ON notices (status);
CREATE INDEX IF NOT EXISTS idx_notices_category ON notices (category);
CREATE INDEX IF NOT EXISTS idx_notices_priority ON notices (priority);
CREATE INDEX IF NOT EXISTS idx_notices_publish_date ON notices (publish_date);
CREATE INDEX IF NOT EXISTS idx_notices_end_date ON notices (end_date);

-- --------------------------------------------------------------------------
-- Supporting tables
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notice_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_notice_category (name)
);

INSERT IGNORE INTO notice_categories (name, sort_order) VALUES
  ('General', 1), ('HR', 2), ('Finance', 3), ('IT', 4), ('Operations', 5),
  ('Sales', 6), ('Recruitment', 7), ('Policy', 8), ('Compliance', 9),
  ('Holiday', 10), ('Emergency', 11), ('Training', 12), ('Event', 13), ('Other', 14);

CREATE TABLE IF NOT EXISTS notice_recipients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_notice_recipient (notice_id, employee_id),
  KEY idx_nr_employee (employee_id),
  CONSTRAINT fk_nr_notice FOREIGN KEY (notice_id) REFERENCES notices (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notice_reads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_notice_read (notice_id, employee_id),
  KEY idx_nrd_employee (employee_id),
  CONSTRAINT fk_nrd_notice FOREIGN KEY (notice_id) REFERENCES notices (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notice_acknowledgements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  acknowledged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_notice_ack (notice_id, employee_id),
  KEY idx_nack_employee (employee_id),
  CONSTRAINT fk_nack_notice FOREIGN KEY (notice_id) REFERENCES notices (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notice_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NULL,
  draft_key VARCHAR(64) NULL,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(150) NULL,
  file_size INT NOT NULL DEFAULT 0,
  storage_url VARCHAR(1024) NOT NULL,
  uploaded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_na_notice (notice_id),
  KEY idx_na_draft (draft_key)
);

CREATE TABLE IF NOT EXISTS notice_audit (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NULL,
  user_id INT NULL,
  user_name VARCHAR(150) NULL,
  action VARCHAR(60) NOT NULL,
  detail VARCHAR(1000) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_naudit_notice (notice_id),
  KEY idx_naudit_action (action)
);

CREATE TABLE IF NOT EXISTS notice_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  version INT NOT NULL,
  heading VARCHAR(200) NOT NULL,
  description MEDIUMTEXT NOT NULL,
  category VARCHAR(80) NULL,
  priority VARCHAR(20) NULL,
  edited_by INT NULL,
  edited_by_name VARCHAR(150) NULL,
  edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_nv_notice (notice_id)
);

CREATE TABLE IF NOT EXISTS notice_deliveries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  channel ENUM('in_app','email') NOT NULL,
  status ENUM('created','sent','failed') NOT NULL DEFAULT 'created',
  error VARCHAR(500) NULL,
  attempts INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_notice_delivery (notice_id, employee_id, channel),
  KEY idx_nd_status (status),
  CONSTRAINT fk_nd_notice FOREIGN KEY (notice_id) REFERENCES notices (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notice_reminders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  notice_id INT NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  reminder_no INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_notice_reminder (notice_id, employee_id, reminder_no),
  CONSTRAINT fk_nrem_notice FOREIGN KEY (notice_id) REFERENCES notices (id) ON DELETE CASCADE
);

-- --------------------------------------------------------------------------
-- RBAC features (management is enforced via notice-board.manage; these extra
-- rows document the granular capabilities available to admins).
-- --------------------------------------------------------------------------
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Publish notices', 'notice-board.publish', 'Publish, schedule, cancel and archive notices', 94 FROM modules WHERE slug = 'notice-board';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'View notice analytics', 'notice-board.analytics', 'View read/acknowledgement analytics and export', 95 FROM modules WHERE slug = 'notice-board';



-- FILE: 2026-10-12-upgrade-knowledge-base.sql
-- ---------------------------------------------------------------------------
-- Knowledge Base upgrade: enterprise KMS on top of the original kb_articles.
--
-- This mirrors the self-healing performed at runtime by lib/knowledge-base.ts
-- (ensureKbSchema). It is safe to run repeatedly. The library will create/patch
-- anything missing on first request, so applying this file is optional but keeps
-- the schema explicit and reviewable.
-- ---------------------------------------------------------------------------

-- Configurable categories.
ALTER TABLE kb_categories ADD COLUMN IF NOT EXISTS active TINYINT(1) NOT NULL DEFAULT 1;
ALTER TABLE kb_categories ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

-- Article lifecycle / metadata columns.
ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS article_code VARCHAR(40) NULL,
  ADD COLUMN IF NOT EXISTS content_type ENUM('article','sop','policy','faq','guide','template','training','announcement') NOT NULL DEFAULT 'article',
  ADD COLUMN IF NOT EXISTS summary VARCHAR(600) NULL,
  ADD COLUMN IF NOT EXISTS content MEDIUMTEXT NULL,
  ADD COLUMN IF NOT EXISTS subcategory VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS tags TEXT NULL,
  ADD COLUMN IF NOT EXISTS audience_type ENUM('all','department','designation','employees','management','admin') NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS audience_config JSON NULL,
  ADD COLUMN IF NOT EXISTS department VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS author_id INT NULL,
  ADD COLUMN IF NOT EXISTS author_name VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS owner_id INT NULL,
  ADD COLUMN IF NOT EXISTS owner_name VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS status ENUM('draft','in_review','scheduled','published','expired','archived','rejected') NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS publish_date DATETIME NULL,
  ADD COLUMN IF NOT EXISTS published_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS effective_date DATE NULL,
  ADD COLUMN IF NOT EXISTS review_date DATE NULL,
  ADD COLUMN IF NOT EXISTS expiry_date DATE NULL,
  ADD COLUMN IF NOT EXISTS expired_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS acknowledgement_required TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notify_in_app TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS notify_email TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pinned TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS keep_pinned_after_expiry TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS important TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS view_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS helpful_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS not_helpful_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recipients_finalized TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reviewer_id INT NULL,
  ADD COLUMN IF NOT EXISTS reviewer_name VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS review_note VARCHAR(1000) NULL,
  ADD COLUMN IF NOT EXISTS reject_reason VARCHAR(1000) NULL,
  ADD COLUMN IF NOT EXISTS source_module VARCHAR(60) NULL,
  ADD COLUMN IF NOT EXISTS source_record_id VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS duplicated_from INT NULL,
  ADD COLUMN IF NOT EXISTS updated_by INT NULL,
  ADD COLUMN IF NOT EXISTS updated_by_name VARCHAR(150) NULL;

-- Keep already-live articles visible after the status column is introduced.
UPDATE kb_articles
   SET status = 'published',
       published_at = COALESCE(published_at, created_at),
       publish_date = COALESCE(publish_date, created_at),
       content = COALESCE(NULLIF(content, ''), description),
       author_id = COALESCE(author_id, created_by),
       author_name = COALESCE(author_name, created_by_name),
       owner_id = COALESCE(owner_id, created_by),
       owner_name = COALESCE(owner_name, created_by_name)
 WHERE status IS NULL OR status = '';

UPDATE kb_articles SET article_code = CONCAT('KB-', YEAR(created_at), '-', LPAD(id, 6, '0'))
 WHERE article_code IS NULL OR article_code = '';

-- Companion tables -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_tags (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, tag VARCHAR(60) NOT NULL,
  UNIQUE KEY uniq_kb_tag (article_id, tag), KEY idx_kb_tag (tag));

CREATE TABLE IF NOT EXISTS kb_recipients (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_recipient (article_id, employee_id), KEY idx_kbr_employee (employee_id));

CREATE TABLE IF NOT EXISTS kb_reads (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_read (article_id, employee_id), KEY idx_kbrd_employee (employee_id));

CREATE TABLE IF NOT EXISTS kb_acknowledgements (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  acknowledged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_ack (article_id, employee_id), KEY idx_kback_employee (employee_id));

CREATE TABLE IF NOT EXISTS kb_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NULL, draft_key VARCHAR(64) NULL,
  file_name VARCHAR(255) NOT NULL, file_type VARCHAR(150) NULL, file_size INT NOT NULL DEFAULT 0,
  storage_url VARCHAR(1024) NOT NULL, uploaded_by INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kba_article (article_id), KEY idx_kba_draft (draft_key));

CREATE TABLE IF NOT EXISTS kb_audit (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NULL, user_id INT NULL, user_name VARCHAR(150) NULL,
  action VARCHAR(60) NOT NULL, detail VARCHAR(1000) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kbaudit_article (article_id), KEY idx_kbaudit_action (action));

CREATE TABLE IF NOT EXISTS kb_versions (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, version INT NOT NULL,
  heading VARCHAR(200) NOT NULL, summary VARCHAR(600) NULL, content MEDIUMTEXT NULL, category_id INT NULL,
  status VARCHAR(20) NULL, change_summary VARCHAR(500) NULL, edited_by INT NULL, edited_by_name VARCHAR(150) NULL,
  edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY idx_kbv_article (article_id));

CREATE TABLE IF NOT EXISTS kb_deliveries (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  channel ENUM('in_app','email') NOT NULL, status ENUM('created','sent','failed') NOT NULL DEFAULT 'created',
  error VARCHAR(500) NULL, attempts INT NOT NULL DEFAULT 0, sent_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_delivery (article_id, employee_id, channel), KEY idx_kbd_status (status));

CREATE TABLE IF NOT EXISTS kb_reminders (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NULL,
  kind VARCHAR(20) NOT NULL, reminder_no INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_reminder (article_id, employee_id, kind, reminder_no));

CREATE TABLE IF NOT EXISTS kb_feedback (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  helpful TINYINT(1) NOT NULL, comment VARCHAR(1000) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_feedback (article_id, employee_id));

CREATE TABLE IF NOT EXISTS kb_favorites (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_kb_favorite (article_id, employee_id));

CREATE TABLE IF NOT EXISTS kb_related (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, related_id INT NOT NULL,
  UNIQUE KEY uniq_kb_related (article_id, related_id));

CREATE TABLE IF NOT EXISTS kb_erp_links (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, source_module VARCHAR(60) NOT NULL,
  source_record_id VARCHAR(80) NOT NULL, label VARCHAR(200) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_kb_erp_link (article_id, source_module, source_record_id));

CREATE TABLE IF NOT EXISTS kb_views (
  id INT AUTO_INCREMENT PRIMARY KEY, article_id INT NOT NULL, employee_id INT UNSIGNED NOT NULL,
  viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kbview_emp (employee_id, viewed_at), KEY idx_kbview_article (article_id));

-- Granular RBAC features (fall back to knowledge-base.manage in code) ---------
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Approve knowledge base', 'knowledge-base.approve', 'Review, approve and reject submitted articles', 94
FROM modules WHERE slug = 'knowledge-base';

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Knowledge base analytics', 'knowledge-base.analytics', 'View read/acknowledgement analytics and feedback', 95
FROM modules WHERE slug = 'knowledge-base';

INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Export knowledge base', 'knowledge-base.export', 'Export the article register to CSV', 96
FROM modules WHERE slug = 'knowledge-base';



-- FILE: 2026-10-13-add-marketing-contacts.sql
-- Marketing > Contacts
-- Mirrors ensureContactSchema() in lib/marketing/contacts-db.ts
-- Contacts, tags, activity timeline, and segments.

CREATE TABLE IF NOT EXISTS marketing_contacts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_code VARCHAR(40) NOT NULL,
  first_name VARCHAR(120) NULL,
  last_name VARCHAR(120) NULL,
  full_name VARCHAR(190) NOT NULL,
  email VARCHAR(190) NULL,
  email_normalized VARCHAR(190) NULL,
  phone VARCHAR(40) NULL,
  phone_normalized VARCHAR(40) NULL,
  company_name VARCHAR(190) NULL,
  job_title VARCHAR(150) NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'Manual',
  lifecycle_stage VARCHAR(30) NOT NULL DEFAULT 'Subscriber',
  status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  owner_id INT UNSIGNED NULL,
  client_id BIGINT UNSIGNED NULL,
  lead_id BIGINT UNSIGNED NULL,
  email_subscription ENUM('Subscribed','Unsubscribed','Pending') NOT NULL DEFAULT 'Subscribed',
  whatsapp_subscription ENUM('Subscribed','Unsubscribed','Pending') NOT NULL DEFAULT 'Pending',
  sms_subscription ENUM('Subscribed','Unsubscribed','Pending') NOT NULL DEFAULT 'Pending',
  consent TINYINT(1) NOT NULL DEFAULT 0,
  consent_source VARCHAR(120) NULL,
  consent_at DATETIME NULL,
  deliverability ENUM('Unknown','Deliverable','Risky','Bounced','Complained') NOT NULL DEFAULT 'Unknown',
  bounce_count INT UNSIGNED NOT NULL DEFAULT 0,
  lead_score INT NOT NULL DEFAULT 0,
  address VARCHAR(255) NULL,
  city VARCHAR(120) NULL,
  state VARCHAR(120) NULL,
  country VARCHAR(120) NULL,
  postal_code VARCHAR(30) NULL,
  language VARCHAR(40) NULL,
  timezone VARCHAR(60) NULL,
  last_activity_at DATETIME NULL,
  last_campaign_at DATETIME NULL,
  notes TEXT NULL,
  archived_at DATETIME NULL,
  archived_by INT UNSIGNED NULL,
  merged_into_id BIGINT UNSIGNED NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contact_code (contact_code),
  KEY idx_mc_name (full_name),
  KEY idx_mc_email (email_normalized),
  KEY idx_mc_phone (phone_normalized),
  KEY idx_mc_status (status),
  KEY idx_mc_stage (lifecycle_stage),
  KEY idx_mc_owner (owner_id),
  KEY idx_mc_client (client_id),
  KEY idx_mc_lead (lead_id),
  KEY idx_mc_archived (archived_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_contact_tags (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id BIGINT UNSIGNED NOT NULL,
  tag VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contact_tag (contact_id, tag),
  KEY idx_mct_tag (tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_contact_activity (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  contact_id BIGINT UNSIGNED NOT NULL,
  contact_code VARCHAR(40) NULL,
  type VARCHAR(40) NOT NULL,
  summary VARCHAR(255) NOT NULL,
  meta JSON NULL,
  actor_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_mca_contact (contact_id),
  KEY idx_mca_type (type),
  KEY idx_mca_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_segments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  segment_code VARCHAR(40) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(255) NULL,
  type ENUM('Static','Dynamic') NOT NULL DEFAULT 'Static',
  rules JSON NULL,
  color VARCHAR(20) NULL,
  created_by INT UNSIGNED NULL,
  archived_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_segment_code (segment_code),
  KEY idx_seg_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_segment_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  segment_id BIGINT UNSIGNED NOT NULL,
  contact_id BIGINT UNSIGNED NOT NULL,
  added_by INT UNSIGNED NULL,
  added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_segment_member (segment_id, contact_id),
  KEY idx_sm_contact (contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Permission matrix features (no-op when the marketing module row is absent).
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Contacts','marketing.contacts.view','View marketing contacts and segments',70 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Manage Contacts','marketing.contacts.manage','Add, edit, import and merge marketing contacts',71 FROM modules WHERE slug='marketing';



-- FILE: 2026-10-13-add-marketing-journeys.sql
-- Marketing > Journeys
-- Mirrors ensureJourneySchema() in lib/marketing/journeys-db.ts
-- Journeys, their steps, contact enrollments, step-run ledger, event log, and dedup.

CREATE TABLE IF NOT EXISTS marketing_journeys (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  journey_code VARCHAR(40) NOT NULL,
  name VARCHAR(190) NOT NULL,
  description VARCHAR(500) NULL,
  status ENUM('Draft','Active','Paused','Completed','Archived') NOT NULL DEFAULT 'Draft',
  trigger_type VARCHAR(40) NOT NULL DEFAULT 'manual',
  trigger_config JSON NULL,
  audience_config JSON NULL,
  goal_type VARCHAR(40) NULL,
  goal_config JSON NULL,
  owner_id INT UNSIGNED NULL,
  allow_reentry TINYINT(1) NOT NULL DEFAULT 0,
  allow_multiple_active TINYINT(1) NOT NULL DEFAULT 0,
  quiet_hours_start INT NULL,
  quiet_hours_end INT NULL,
  start_at DATETIME NULL,
  end_at DATETIME NULL,
  activated_at DATETIME NULL,
  archived_at DATETIME NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_journey_code (journey_code),
  KEY idx_j_status (status),
  KEY idx_j_trigger (trigger_type),
  KEY idx_j_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_journey_steps (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  journey_id BIGINT UNSIGNED NOT NULL,
  step_order INT NOT NULL DEFAULT 0,
  type VARCHAR(40) NOT NULL,
  name VARCHAR(190) NULL,
  config JSON NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_js_journey (journey_id),
  KEY idx_js_order (journey_id, step_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_journey_enrollments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  enrollment_code VARCHAR(40) NOT NULL,
  journey_id BIGINT UNSIGNED NOT NULL,
  contact_id BIGINT UNSIGNED NOT NULL,
  status ENUM('Active','Waiting','Completed','Paused','Exited','Failed') NOT NULL DEFAULT 'Active',
  current_step_order INT NOT NULL DEFAULT 0,
  next_run_at DATETIME NULL,
  goal_reached TINYINT(1) NOT NULL DEFAULT 0,
  exit_reason VARCHAR(190) NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'trigger',
  attempt_count INT NOT NULL DEFAULT 0,
  locked_at DATETIME NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_action_at DATETIME NULL,
  completed_at DATETIME NULL,
  enrolled_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_enrollment_code (enrollment_code),
  KEY idx_je_journey (journey_id),
  KEY idx_je_contact (contact_id),
  KEY idx_je_status (status),
  KEY idx_je_due (status, next_run_at),
  KEY idx_je_active (journey_id, contact_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_journey_step_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  enrollment_id BIGINT UNSIGNED NOT NULL,
  journey_id BIGINT UNSIGNED NOT NULL,
  step_id BIGINT UNSIGNED NULL,
  step_order INT NOT NULL DEFAULT 0,
  contact_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(40) NOT NULL,
  status ENUM('Completed','Skipped','Failed') NOT NULL DEFAULT 'Completed',
  idempotency_key VARCHAR(120) NOT NULL,
  result JSON NULL,
  error VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_step_run (idempotency_key),
  KEY idx_jsr_enrollment (enrollment_id),
  KEY idx_jsr_journey (journey_id),
  KEY idx_jsr_type (type),
  KEY idx_jsr_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_journey_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  journey_id BIGINT UNSIGNED NULL,
  enrollment_id BIGINT UNSIGNED NULL,
  contact_id BIGINT UNSIGNED NULL,
  step_id BIGINT UNSIGNED NULL,
  action VARCHAR(60) NOT NULL,
  detail VARCHAR(500) NULL,
  meta JSON NULL,
  actor_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_jev_journey (journey_id),
  KEY idx_jev_enrollment (enrollment_id),
  KEY idx_jev_contact (contact_id),
  KEY idx_jev_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_journey_event_dedup (
  event_key VARCHAR(191) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Permission matrix features (no-op when the marketing module row is absent).
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Journeys','marketing.journeys.view','View marketing automation journeys',80 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Manage Journeys','marketing.journeys.manage','Create, edit, activate and enroll into journeys',81 FROM modules WHERE slug='marketing';



-- FILE: 2026-10-13-add-marketing-lead-generation.sql
-- Marketing > Lead Generation
-- Mirrors ensureLeadGenSchema() in lib/marketing/leadgen-db.ts
-- Forms, their fields, submissions, and a lightweight view/submit event log.

CREATE TABLE IF NOT EXISTS leadgen_forms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  form_code VARCHAR(40) NOT NULL,
  public_token VARCHAR(48) NOT NULL,
  name VARCHAR(190) NOT NULL,
  description VARCHAR(500) NULL,
  type ENUM('Embed','Hosted','Popup') NOT NULL DEFAULT 'Hosted',
  status ENUM('Draft','Published','Paused','Archived') NOT NULL DEFAULT 'Draft',
  submit_label VARCHAR(80) NOT NULL DEFAULT 'Submit',
  success_message VARCHAR(500) NULL,
  redirect_url VARCHAR(500) NULL,
  theme_color VARCHAR(20) NULL,
  campaign VARCHAR(190) NULL,
  lead_source VARCHAR(120) NULL,
  default_owner_id INT UNSIGNED NULL,
  notify_user_id INT UNSIGNED NULL,
  auto_create_lead TINYINT(1) NOT NULL DEFAULT 1,
  view_count INT UNSIGNED NOT NULL DEFAULT 0,
  submission_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_by INT UNSIGNED NULL,
  archived_at DATETIME NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_form_code (form_code),
  UNIQUE KEY uq_form_token (public_token),
  KEY idx_lgf_status (status),
  KEY idx_lgf_owner (default_owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS leadgen_form_fields (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  form_id BIGINT UNSIGNED NOT NULL,
  field_key VARCHAR(60) NOT NULL,
  label VARCHAR(150) NOT NULL,
  type ENUM('text','email','tel','textarea','number','select','checkbox','hidden') NOT NULL DEFAULT 'text',
  placeholder VARCHAR(190) NULL,
  help_text VARCHAR(255) NULL,
  required TINYINT(1) NOT NULL DEFAULT 0,
  options JSON NULL,
  maps_to VARCHAR(40) NOT NULL DEFAULT 'none',
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lgff_form (form_id, sort_order),
  UNIQUE KEY uq_lgff_key (form_id, field_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS leadgen_submissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  submission_code VARCHAR(40) NOT NULL,
  form_id BIGINT UNSIGNED NOT NULL,
  form_code VARCHAR(40) NULL,
  data JSON NULL,
  full_name VARCHAR(190) NULL,
  email VARCHAR(190) NULL,
  email_normalized VARCHAR(190) NULL,
  phone VARCHAR(40) NULL,
  company_name VARCHAR(190) NULL,
  status ENUM('New','Converted','Spam','Duplicate') NOT NULL DEFAULT 'New',
  contact_id BIGINT UNSIGNED NULL,
  lead_id INT UNSIGNED NULL,
  lead_code VARCHAR(40) NULL,
  is_spam TINYINT(1) NOT NULL DEFAULT 0,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  referrer VARCHAR(500) NULL,
  utm JSON NULL,
  processed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_submission_code (submission_code),
  KEY idx_lgs_form (form_id, created_at),
  KEY idx_lgs_status (status),
  KEY idx_lgs_email (email_normalized),
  KEY idx_lgs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per public view/submit so the funnel can compare views vs. submissions.
CREATE TABLE IF NOT EXISTS leadgen_form_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  form_id BIGINT UNSIGNED NOT NULL,
  type ENUM('view','submit') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lge_form (form_id, type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Permission matrix features (no-op when the marketing module row is absent).
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Lead Generation','marketing.lead_generation.view','View lead capture forms and submissions',60 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Manage Lead Generation','marketing.lead_generation.manage','Create, edit and publish lead capture forms',61 FROM modules WHERE slug='marketing';



-- FILE: 2026-10-13-add-marketing-planner.sql
-- Marketing > Marketing Planner
-- Content calendar board: each item moves across Backlog -> Planned -> In Progress -> Published.
-- The Planner UI (components/marketing/marketing-planner-client.tsx) is currently
-- client-only; this table gives it durable persistence.

CREATE TABLE IF NOT EXISTS marketing_planner_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_code VARCHAR(40) NOT NULL,
  title VARCHAR(190) NOT NULL,
  description VARCHAR(1000) NULL,
  channel VARCHAR(60) NOT NULL DEFAULT 'Email',
  status ENUM('Backlog','Planned','In Progress','Published') NOT NULL DEFAULT 'Backlog',
  sort_order INT NOT NULL DEFAULT 0,
  due_date DATE NULL,
  publish_at DATETIME NULL,
  published_at DATETIME NULL,
  campaign VARCHAR(190) NULL,
  owner_id INT UNSIGNED NULL,
  assignee_id INT UNSIGNED NULL,
  color VARCHAR(20) NULL,
  tags JSON NULL,
  meta JSON NULL,
  archived_at DATETIME NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_planner_code (item_code),
  KEY idx_mp_status (status, sort_order),
  KEY idx_mp_channel (channel),
  KEY idx_mp_due (due_date),
  KEY idx_mp_owner (owner_id),
  KEY idx_mp_archived (archived_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Permission matrix features (no-op when the marketing module row is absent).
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Marketing Planner','marketing.planner.view','View the marketing content calendar',90 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Manage Marketing Planner','marketing.planner.manage','Create, edit and schedule planner items',91 FROM modules WHERE slug='marketing';



-- FILE: 2026-11-05-marketing-planner-upgrade.sql
-- Marketing > Marketing Planner â€” production upgrade
-- Extends the minimal planner table into a full planning / scheduling /
-- assignment / review / dependency system and adds supporting tables.
--
-- NOTE: The application self-heals this schema at runtime via
-- `ensurePlannerSchema()` in lib/marketing/planner-db.ts, so running this file
-- is optional. It is provided for environments that manage schema via SQL and
-- as documentation of the target shape. All statements are idempotent-friendly
-- (guarded by IF NOT EXISTS or additive column adds).

-- Widen status from the original 4-value ENUM to a VARCHAR that fits the
-- expanded workflow (Draft, Assigned, Review, Blocked, Scheduled, Ready,
-- Completed, Cancelled, Archived).
ALTER TABLE marketing_planner_items
  MODIFY COLUMN status VARCHAR(40) NOT NULL DEFAULT 'Backlog';

-- Item master extensions (see planner-db.ts for the authoritative list).
ALTER TABLE marketing_planner_items
  ADD COLUMN IF NOT EXISTS content_type VARCHAR(60) NOT NULL DEFAULT 'Other',
  ADD COLUMN IF NOT EXISTS priority VARCHAR(16) NOT NULL DEFAULT 'Normal',
  ADD COLUMN IF NOT EXISTS start_date DATE NULL,
  ADD COLUMN IF NOT EXISTS campaign_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS journey_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS segment_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS email_template_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS whatsapp_template_name VARCHAR(191) NULL,
  ADD COLUMN IF NOT EXISTS brief JSON NULL,
  ADD COLUMN IF NOT EXISTS target_audience JSON NULL,
  ADD COLUMN IF NOT EXISTS estimated_budget DECIMAL(14,2) NULL,
  ADD COLUMN IF NOT EXISTS actual_spend DECIMAL(14,2) NULL,
  ADD COLUMN IF NOT EXISTS related_type VARCHAR(40) NULL,
  ADD COLUMN IF NOT EXISTS related_id VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS review_status VARCHAR(24) NOT NULL DEFAULT 'None',
  ADD COLUMN IF NOT EXISTS submitted_by INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS submitted_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS blocked_reason VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS blocked_by INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS blocked_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS ready_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS recurrence JSON NULL,
  ADD COLUMN IF NOT EXISTS recurrence_parent_id BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS next_recurrence_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS row_version INT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS marketing_planner_assignees (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'contributor',
  assigned_by INT UNSIGNED NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_planner_assignee (item_id, user_id),
  KEY idx_pa_user (user_id),
  KEY idx_pa_item (item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_dependencies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  depends_on_id BIGINT UNSIGNED NOT NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_planner_dep (item_id, depends_on_id),
  KEY idx_pd_item (item_id),
  KEY idx_pd_dep (depends_on_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'comment',
  user_id INT UNSIGNED NULL,
  body VARCHAR(2000) NOT NULL,
  meta JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pc_item (item_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  version INT NOT NULL,
  snapshot JSON NULL,
  change_summary VARCHAR(500) NULL,
  changed_by INT UNSIGNED NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pv_item (item_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_reminders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  stage VARCHAR(24) NOT NULL,
  due_at DATETIME NULL,
  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_planner_reminder (item_id, stage),
  KEY idx_pr_item (item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_activity (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(40) NOT NULL,
  field VARCHAR(60) NULL,
  old_value TEXT NULL,
  new_value TEXT NULL,
  reason VARCHAR(500) NULL,
  user_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pact_item (item_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_planner_assets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  library_asset_id VARCHAR(64) NULL,
  label VARCHAR(255) NOT NULL,
  url VARCHAR(1000) NULL,
  kind VARCHAR(40) NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pas_item (item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Granular RBAC features (no-op when the marketing module row is absent).
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Assign Planner Work','marketing.planner.assign','Assign planner items to team members',92 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Approve Planner Content','marketing.planner.approve','Review and approve planner content',93 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Publish Planner Content','marketing.planner.publish','Mark planner content as published',94 FROM modules WHERE slug='marketing';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
  SELECT id,'Export Planner Data','marketing.planner.export','Export planner metadata',95 FROM modules WHERE slug='marketing';



-- FILE: 2026-11-06-add-multi-tenant-foundation.sql
-- =============================================================
-- SPEC 1 â€” Multi-tenant SaaS foundation (additive, non-destructive)
-- -------------------------------------------------------------
-- Principles:
--   * A single Muenot platform hosts multiple independent customer
--     organizations ("tenants"). Every tenant owns logically isolated
--     data. The existing Muenot internal organization is seeded as the
--     default, platform-owner tenant so nothing about the current
--     single-org install changes behaviourally.
--   * Tenant context is ALWAYS derived server-side from the authenticated
--     session (users.tenant_id), never from client input. The `slug`
--     (subdomain) is only a hint used before/at authentication.
--   * The model supports three deployment strategies so future customers
--     can be onboarded without re-architecting:
--       - shared_database    : row-level isolation via tenant_id (default)
--       - separate_schema    : one MySQL schema per tenant (db_schema)
--       - dedicated_database : an isolated database, referenced by
--                              db_connection_ref (NEVER stores secrets;
--                              the ref points at env/secret-store config).
--
-- This file documents the target schema for fresh installs. The same
-- objects are also created/altered idempotently at runtime by
-- ensureTenantSchema() in lib/tenant-service.ts, so existing databases
-- self-heal without a manual migration step.
--
-- SAFE TO RE-RUN. MySQL 8 has no reliable `ADD COLUMN IF NOT EXISTS`, so
-- column / key / FK changes go through helper procedures that check
-- information_schema first (mirrors the runtime ensure helpers).
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Table: tenants
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tenants` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(150) NOT NULL,
  `slug` VARCHAR(100) NOT NULL,
  `status` ENUM('active','suspended','inactive') NOT NULL DEFAULT 'active',
  `deployment_model` ENUM('shared_database','separate_schema','dedicated_database')
      NOT NULL DEFAULT 'shared_database',
  `plan` VARCHAR(50) NOT NULL DEFAULT 'internal',
  -- Non-secret references for non-shared deployment models. Actual
  -- credentials live in the secret store / env, keyed by these refs.
  `db_schema` VARCHAR(190) DEFAULT NULL,
  `db_connection_ref` VARCHAR(190) DEFAULT NULL,
  `settings` JSON DEFAULT NULL,
  -- 1 for the Muenot internal organization (the platform owner tenant).
  `is_platform_owner` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tenants_slug` (`slug`),
  KEY `idx_tenants_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the default platform-owner tenant (Muenot). Idempotent on slug.
INSERT INTO `tenants` (`name`, `slug`, `status`, `deployment_model`, `plan`, `is_platform_owner`)
VALUES ('Muenot', 'muenot', 'active', 'shared_database', 'internal', 1)
ON DUPLICATE KEY UPDATE `name` = `name`;

DELIMITER $$

-- Adds a column only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__mt_add_column` $$
CREATE PROCEDURE `__mt_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

-- Adds an index only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__mt_add_key` $$
CREATE PROCEDURE `__mt_add_key`(IN p_table VARCHAR(64), IN p_key VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_key
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

-- Adds a foreign key only when it is missing from the table.
DROP PROCEDURE IF EXISTS `__mt_add_fk` $$
CREATE PROCEDURE `__mt_add_fk`(IN p_table VARCHAR(64), IN p_fk VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = p_table
      AND constraint_name = p_fk AND constraint_type = 'FOREIGN KEY'
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD CONSTRAINT `', p_fk, '` ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- Attach every existing user to a tenant. Column is nullable while we
-- backfill, then constrained below.
CALL `__mt_add_column`('users', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');

-- Backfill: existing rows belong to the default (platform-owner) tenant.
UPDATE `users`
   SET `tenant_id` = (SELECT `id` FROM `tenants` WHERE `slug` = 'muenot' LIMIT 1)
 WHERE `tenant_id` IS NULL;

-- Index + FK for fast, safe tenant scoping.
CALL `__mt_add_key`('users', 'idx_users_tenant', 'KEY `idx_users_tenant` (`tenant_id`)');
CALL `__mt_add_key`('users', 'uniq_users_tenant_email', 'UNIQUE KEY `uniq_users_tenant_email` (`tenant_id`, `email`)');
CALL `__mt_add_fk`(
  'users',
  'fk_users_tenant',
  'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE'
);

DROP PROCEDURE IF EXISTS `__mt_add_column`;
DROP PROCEDURE IF EXISTS `__mt_add_key`;
DROP PROCEDURE IF EXISTS `__mt_add_fk`;



-- FILE: 2026-11-07-tenant-data-isolation.sql
-- =============================================================
-- SPEC 2 â€” Tenant data isolation (additive, non-destructive)
-- -------------------------------------------------------------
-- Adds the `tenant_id` discriminator, a covering index, and a foreign key to
-- every tenant-owned business table (see lib/tenant-tables.ts for the
-- authoritative registry). Existing rows are backfilled onto the default
-- platform-owner tenant (Muenot) so the current single-org install keeps
-- working unchanged.
--
-- Enforcement (rejecting cross-tenant reads/writes) is centralized in the
-- application data layer: lib/tenant-guard.ts inspects every query and
-- lib/tenant-scope.ts injects the tenant predicate. MySQL has no row-level
-- security, so the database side provides the columns, indexes, and referential
-- integrity that make that enforcement correct and fast.
--
-- SAFE TO RE-RUN. The same objects are also created idempotently at runtime by
-- ensureTenantIsolation() in lib/tenant-guard.ts, so existing databases
-- self-heal without a manual migration step. Column / key / FK changes go
-- through helper procedures that check information_schema first (MySQL 8 has no
-- reliable ADD ... IF NOT EXISTS).
-- =============================================================

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `__ti_add_column` $$
CREATE PROCEDURE `__ti_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__ti_add_key` $$
CREATE PROCEDURE `__ti_add_key`(IN p_table VARCHAR(64), IN p_key VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (SELECT 1 FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_key) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__ti_add_fk` $$
CREATE PROCEDURE `__ti_add_fk`(IN p_table VARCHAR(64), IN p_fk VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE table_schema = DATABASE() AND table_name = p_table
               AND constraint_name = p_fk AND constraint_type = 'FOREIGN KEY') THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD CONSTRAINT `', p_fk, '` ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- Add tenant_id + covering index per tenant-owned table (see
-- lib/tenant-tables.ts for the authoritative registry).
CALL `__ti_add_column`('sales_leads', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_leads', 'idx_sales_leads_tenant', 'KEY `idx_sales_leads_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_companies', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_companies', 'idx_sales_companies_tenant', 'KEY `idx_sales_companies_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_meetings', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_meetings', 'idx_sales_meetings_tenant', 'KEY `idx_sales_meetings_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_quotations', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_quotations', 'idx_sales_quotations_tenant', 'KEY `idx_sales_quotations_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_contracts', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_contracts', 'idx_sales_contracts_tenant', 'KEY `idx_sales_contracts_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_onboarding', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_onboarding', 'idx_sales_onboarding_tenant', 'KEY `idx_sales_onboarding_tenant` (`tenant_id`)');
CALL `__ti_add_column`('sales_revenue_forecast', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('sales_revenue_forecast', 'idx_sales_revenue_forecast_tenant', 'KEY `idx_sales_revenue_forecast_tenant` (`tenant_id`)');
CALL `__ti_add_column`('clients', 'tenant_id', '`tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`');
CALL `__ti_add_key`('clients', 'idx_clients_tenant', 'KEY `idx_clients_tenant` (`tenant_id`)');

-- Backfill every tenant-owned table onto the default (platform-owner) tenant.
UPDATE `sales_leads`            SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_companies`        SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_meetings`         SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_quotations`       SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_contracts`        SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_onboarding`       SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `sales_revenue_forecast` SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;
UPDATE `clients`                SET `tenant_id` = (SELECT id FROM `tenants` WHERE slug='muenot' LIMIT 1) WHERE `tenant_id` IS NULL;

-- Referential integrity to the tenant directory.
CALL `__ti_add_fk`('sales_leads',            'fk_sales_leads_tenant',            'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_companies',        'fk_sales_companies_tenant',        'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_meetings',         'fk_sales_meetings_tenant',         'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_quotations',       'fk_sales_quotations_tenant',       'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_contracts',        'fk_sales_contracts_tenant',        'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_onboarding',       'fk_sales_onboarding_tenant',       'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('sales_revenue_forecast', 'fk_sales_revenue_forecast_tenant', 'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');
CALL `__ti_add_fk`('clients',                'fk_clients_tenant',                'FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE');

DROP PROCEDURE IF EXISTS `__ti_tenantize`;
DROP PROCEDURE IF EXISTS `__ti_add_column`;
DROP PROCEDURE IF EXISTS `__ti_add_key`;
DROP PROCEDURE IF EXISTS `__ti_add_fk`;



-- FILE: 2026-11-08-platform-tenant-roles.sql
-- =============================================================
-- SPEC 3 â€” Platform vs Tenant role separation (additive, non-destructive)
-- -------------------------------------------------------------
-- Introduces two ORTHOGONAL role axes on `users` plus an audit trail, so that
-- operating the Muenot PLATFORM and operating a single TENANT's data are
-- distinct, separately-granted authorities that cannot be mistaken for each
-- other (see lib/role-model.ts for the boundary rules):
--
--   users.platform_role  ENUM('none','platform_staff','platform_super_admin')
--   users.tenant_role    ENUM('employee','module_admin','tenant_admin','tenant_owner')
--
-- The legacy `users.role` (admin|employee) is preserved untouched so every
-- existing feature/permission-matrix check keeps working; `tenant_role` is
-- backfilled from it (admin -> tenant_admin, else employee).
--
-- `platform_admin_audit` records every platform/tenant role change and every
-- tenant impersonation start/stop for the penetration-style review (Phase 4).
--
-- SAFE TO RE-RUN. The same objects are also created idempotently at runtime by
-- ensurePlatformRoleSchema() in lib/platform-roles.ts, so existing databases
-- self-heal without a manual migration step (matching the project's other
-- lib/*-ensure helpers). MySQL 8 has no reliable ADD ... IF NOT EXISTS, so
-- column changes go through a helper procedure that checks information_schema.
-- =============================================================

SET NAMES utf8mb4;

DELIMITER $$

DROP PROCEDURE IF EXISTS `__pr_add_column` $$
CREATE PROCEDURE `__pr_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DROP PROCEDURE IF EXISTS `__pr_add_key` $$
CREATE PROCEDURE `__pr_add_key`(IN p_table VARCHAR(64), IN p_key VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = p_table)
     AND NOT EXISTS (SELECT 1 FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_key) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END $$

DELIMITER ;

-- Two orthogonal role axes on users.
CALL `__pr_add_column`('users', 'platform_role',
  "`platform_role` ENUM('none','platform_staff','platform_super_admin') NOT NULL DEFAULT 'none' AFTER `role`");
CALL `__pr_add_column`('users', 'tenant_role',
  "`tenant_role` ENUM('employee','module_admin','tenant_admin','tenant_owner') NOT NULL DEFAULT 'employee' AFTER `platform_role`");

CALL `__pr_add_key`('users', 'idx_users_platform_role', 'KEY `idx_users_platform_role` (`platform_role`)');
CALL `__pr_add_key`('users', 'idx_users_tenant_role', 'KEY `idx_users_tenant_role` (`tenant_role`)');

-- Backfill tenant_role from the legacy coarse role. Admins become tenant_admin;
-- everyone else stays a normal employee (module-admin and owner are explicit
-- opt-in distinctions granted later through the console).
UPDATE `users` SET `tenant_role` = 'tenant_admin' WHERE `role` = 'admin'  AND `tenant_role` = 'employee';
UPDATE `users` SET `tenant_role` = 'employee'     WHERE `role` = 'employee' AND `tenant_role` = 'employee';

-- Bootstrap a single platform operator so the platform console is reachable
-- without hand-editing the DB: the earliest-created admin in the platform-owner
-- tenant (Muenot) becomes platform_super_admin, but ONLY if no platform
-- super admin exists yet. This never downgrades or overrides an explicit grant.
UPDATE `users`
   SET `platform_role` = 'platform_super_admin'
 WHERE `id` = (
   SELECT id FROM (
     SELECT u.id
       FROM `users` u
       JOIN `tenants` t ON t.id = u.tenant_id
      WHERE t.is_platform_owner = 1 AND u.role = 'admin' AND u.status = 'active'
      ORDER BY u.id ASC
      LIMIT 1
   ) AS pick
 )
 AND NOT EXISTS (
   SELECT 1 FROM (SELECT * FROM `users`) u2 WHERE u2.platform_role = 'platform_super_admin'
 );

-- Audit trail for role changes and impersonation (penetration-review evidence).
CREATE TABLE IF NOT EXISTS `platform_admin_audit` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `actor_user_id` INT UNSIGNED NOT NULL,
  `actor_email` VARCHAR(190) DEFAULT NULL,
  `action` VARCHAR(64) NOT NULL,
  `target_user_id` INT UNSIGNED DEFAULT NULL,
  `target_tenant_id` INT UNSIGNED DEFAULT NULL,
  `detail` JSON DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_paa_actor` (`actor_user_id`),
  KEY `idx_paa_action` (`action`),
  KEY `idx_paa_target_tenant` (`target_tenant_id`),
  KEY `idx_paa_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS `__pr_add_column`;
DROP PROCEDURE IF EXISTS `__pr_add_key`;



-- FILE: 2026-11-12-org-hierarchy.sql
-- SPEC 6 â€” Organization hierarchy.
-- ---------------------------------------------------------------------------
-- One self-referential tree of typed org units per tenant, plus a userâ†”unit
-- assignment layer and a change log. Complements (does not replace) the HR
-- hr_departments / hr_designations trees and the finance cost-centre field.
--
-- All three tables are tenant-owned (lib/tenant-tables.ts): the runtime
-- self-heal in lib/org-hierarchy.ts#ensureOrgSchema mirrors this file so
-- existing databases converge without a manual migration step.

CREATE TABLE IF NOT EXISTS org_units (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  unit_code VARCHAR(40) NOT NULL,
  name VARCHAR(180) NOT NULL,
  unit_type ENUM(
    'organization','legal_entity','group','business_unit','division',
    'department','team','branch','location','cost_center','profit_center'
  ) NOT NULL,
  parent_id INT UNSIGNED DEFAULT NULL,
  -- Materialized path of ids ("/1/4/9/") for single-index subtree queries.
  path VARCHAR(600) NOT NULL DEFAULT '',
  depth INT UNSIGNED NOT NULL DEFAULT 0,
  head_user_id INT UNSIGNED DEFAULT NULL,
  external_code VARCHAR(80) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  sort_order INT NOT NULL DEFAULT 0,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  archived_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_units_tenant_code (tenant_id, unit_code),
  KEY idx_org_units_tenant (tenant_id),
  KEY idx_org_units_parent (parent_id),
  KEY idx_org_units_type (unit_type),
  KEY idx_org_units_path (path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS org_unit_assignments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  org_unit_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  assignment_title VARCHAR(150) DEFAULT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_assignment (tenant_id, org_unit_id, user_id),
  KEY idx_org_assignment_tenant (tenant_id),
  KEY idx_org_assignment_unit (org_unit_id),
  KEY idx_org_assignment_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS org_unit_change_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  org_unit_id INT UNSIGNED DEFAULT NULL,
  action VARCHAR(40) NOT NULL,
  actor_user_id INT UNSIGNED DEFAULT NULL,
  actor_name VARCHAR(180) DEFAULT NULL,
  detail VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_org_change_tenant (tenant_id),
  KEY idx_org_change_unit (org_unit_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cross-module integration: reference an org unit from HR employees and the
-- finance journal for hierarchy-aware HR / Finance / reporting slices.
-- Additive + nullable so existing rows and code paths are unaffected.
ALTER TABLE hr_employees ADD COLUMN org_unit_id INT UNSIGNED DEFAULT NULL;
ALTER TABLE hr_employees ADD KEY idx_hr_employees_org_unit (org_unit_id);
ALTER TABLE journal_entries ADD COLUMN org_unit_id INT UNSIGNED DEFAULT NULL;
ALTER TABLE journal_entries ADD KEY idx_journal_entries_org_unit (org_unit_id);



-- FILE: 2026-11-13-multi-entity.sql
-- SPEC 7 â€” Multi-entity support.
-- ---------------------------------------------------------------------------
-- Lets a SINGLE tenant operate multiple legal / business entities, each with
-- its own tax identity (GST/VAT), bank accounts, accounting book and address,
-- while still rolling everything up into consolidated reporting.
--
-- This file is the canonical migration; lib/legal-entities.ts ships an
-- idempotent self-heal (ensureEntitySchema) that mirrors it exactly so a fresh
-- tenant is provisioned on first use even before this runs. Everything here is
-- additive and safe to re-run (IF NOT EXISTS / additive ALTERs).

CREATE TABLE IF NOT EXISTS legal_entities (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  entity_code VARCHAR(40) NOT NULL,
  name VARCHAR(190) NOT NULL,
  legal_name VARCHAR(190) DEFAULT NULL,
  entity_type VARCHAR(40) NOT NULL DEFAULT 'private_limited',
  registration_no VARCHAR(80) DEFAULT NULL,
  tax_name VARCHAR(40) DEFAULT NULL,
  tax_number VARCHAR(60) DEFAULT NULL,
  secondary_tax_name VARCHAR(40) DEFAULT NULL,
  secondary_tax_number VARCHAR(60) DEFAULT NULL,
  base_currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  book_name VARCHAR(120) DEFAULT NULL,
  email VARCHAR(190) DEFAULT NULL,
  phone VARCHAR(40) DEFAULT NULL,
  address_line VARCHAR(255) DEFAULT NULL,
  city VARCHAR(120) DEFAULT NULL,
  state VARCHAR(120) DEFAULT NULL,
  postal_code VARCHAR(30) DEFAULT NULL,
  country VARCHAR(120) DEFAULT NULL,
  org_unit_id INT UNSIGNED DEFAULT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_legal_entities_tenant_code (tenant_id, entity_code),
  KEY idx_legal_entities_tenant (tenant_id),
  KEY idx_legal_entities_org_unit (org_unit_id),
  KEY idx_legal_entities_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS legal_entity_bank_accounts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  entity_id INT UNSIGNED NOT NULL,
  account_name VARCHAR(190) NOT NULL,
  bank_name VARCHAR(190) DEFAULT NULL,
  account_no VARCHAR(60) DEFAULT NULL,
  ifsc_swift VARCHAR(40) DEFAULT NULL,
  branch VARCHAR(190) DEFAULT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  account_type VARCHAR(40) DEFAULT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_entity_bank_tenant (tenant_id),
  KEY idx_entity_bank_entity (entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS intercompany_transactions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED DEFAULT NULL,
  txn_code VARCHAR(40) NOT NULL,
  from_entity_id INT UNSIGNED NOT NULL,
  to_entity_id INT UNSIGNED NOT NULL,
  txn_date DATE DEFAULT NULL,
  amount DECIMAL(16,2) NOT NULL DEFAULT 0,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  category VARCHAR(80) DEFAULT NULL,
  description VARCHAR(500) DEFAULT NULL,
  reference_no VARCHAR(120) DEFAULT NULL,
  status ENUM('draft','posted','settled','cancelled') NOT NULL DEFAULT 'draft',
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_intercompany_tenant_code (tenant_id, txn_code),
  KEY idx_intercompany_tenant (tenant_id),
  KEY idx_intercompany_from (from_entity_id),
  KEY idx_intercompany_to (to_entity_id),
  KEY idx_intercompany_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Thread entity context onto finance ledgers + documents. Additive + nullable
-- so every existing posted row keeps working (entity_id NULL => "Unassigned").
-- These mirror ENTITY_LINKED_TABLES in lib/legal-entities.ts. Guarded ALTERs
-- (MySQL lacks ADD COLUMN IF NOT EXISTS on older versions; the app self-heal
-- checks information_schema before altering).
ALTER TABLE journal_entries  ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_journal_entries_entity (entity_id);
ALTER TABLE general_ledger   ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_general_ledger_entity (entity_id);
ALTER TABLE finance_accounts ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_finance_accounts_entity (entity_id);
ALTER TABLE finance_records  ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_finance_records_entity (entity_id);
ALTER TABLE sales_invoices   ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_sales_invoices_entity (entity_id);
ALTER TABLE purchase_bills   ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_purchase_bills_entity (entity_id);
ALTER TABLE expenses         ADD COLUMN entity_id INT UNSIGNED DEFAULT NULL, ADD KEY idx_expenses_entity (entity_id);



-- FILE: 2026-11-16-employee-user-link.sql
-- SPEC 15 â€” Employee â‡„ User link.
--
-- Establishes the durable relationship between HR employees and login users:
--   * `users.account_type`      â€” 'person' (default) or 'service' (no employee).
--   * `hr_employees.user_id`     â€” one employee â†’ at most one login user.
--   * `hr_employees.entity_id`   â€” legal entity the employment belongs to, so a
--                                  single user can be linked to several employee
--                                  rows across different entities (multi-entity)
--                                  while duplicates within one entity are blocked.
--   * `employee_user_link_events`â€” append-only audit of link/unlink/account-type
--                                  changes and access-status synchronizations.
--
-- Additive and idempotent: the DB layer (lib/employee-user-link.ts) self-heals
-- the same objects at runtime, so this file is safe to (re)apply by hand.

ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `account_type` VARCHAR(20) NOT NULL DEFAULT 'person';

ALTER TABLE `hr_employees`
  ADD COLUMN IF NOT EXISTS `user_id` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `entity_id` INT UNSIGNED DEFAULT NULL;

ALTER TABLE `hr_employees` ADD INDEX IF NOT EXISTS `idx_hr_user` (`user_id`);
ALTER TABLE `hr_employees` ADD INDEX IF NOT EXISTS `idx_hr_entity` (`entity_id`);

CREATE TABLE IF NOT EXISTS `employee_user_link_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `employee_pk` INT UNSIGNED DEFAULT NULL,
  `user_id` INT UNSIGNED DEFAULT NULL,
  `action` VARCHAR(40) NOT NULL,
  `detail` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `actor_name` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_eul_tenant` (`tenant_id`, `created_at`),
  KEY `idx_eul_user` (`user_id`),
  KEY `idx_eul_emp` (`employee_pk`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-11-17-add-subscription-billing-module.sql
-- ============================================================================
-- Subscription & Billing module â€” SPEC 16 â†’ SPEC 25
-- ----------------------------------------------------------------------------
-- This is the persisted, canonical schema for the entire Subscription & Billing
-- module (the "Subscription & Billing" nav group: Subscription Management, Plan
-- Management, Feature Entitlements, Usage Metering, Billing, Payment Gateways,
-- Payment Webhooks, Invoices & Credit Notes, Renewals, Customer Billing Portal).
--
-- Every table below is also self-healed at runtime by the engines in
-- lib/billing/* (each calls CREATE TABLE IF NOT EXISTS on first use). This file
-- mirrors those definitions verbatim so the schema can be provisioned, code-
-- reviewed and version-controlled up front instead of only lazily at runtime.
-- Everything is idempotent (CREATE TABLE IF NOT EXISTS / ON DUPLICATE KEY), so
-- it is safe to run against a fresh DB or one the engines have already touched.
--
-- Tenancy: every operational table carries tenant_id and is filtered through
-- lib/tenant-scope in application code. The plan CATALOGUE (saas_plans) is the
-- one intentional exception â€” it is a global catalogue shared by all tenants.
-- ============================================================================


-- ============================================================================
-- SPEC 16 â€” SUBSCRIPTION MANAGEMENT   (lib/billing/subscription-engine.ts)
-- Monthly / yearly / 2-year / 5-year terms; trial â†’ active â†’ past_due â†’
-- grace â†’ suspended â†’ cancelled â†’ expired lifecycle, plus renewals.
-- ============================================================================

-- Global plan catalogue â€” shared across every tenant (NOT tenant-scoped).
CREATE TABLE IF NOT EXISTS saas_plans (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  plan_code       VARCHAR(30) NOT NULL,
  name            VARCHAR(150) NOT NULL,
  description     TEXT DEFAULT NULL,
  currency        VARCHAR(10) NOT NULL DEFAULT 'USD',
  price_monthly   DECIMAL(14,2) NOT NULL DEFAULT 0,
  price_yearly    DECIMAL(14,2) NOT NULL DEFAULT 0,
  price_two_year  DECIMAL(14,2) NOT NULL DEFAULT 0,
  price_five_year DECIMAL(14,2) NOT NULL DEFAULT 0,
  trial_days      INT UNSIGNED NOT NULL DEFAULT 0,
  seats           INT UNSIGNED DEFAULT NULL,
  past_due_days   INT UNSIGNED NOT NULL DEFAULT 7,
  grace_days      INT UNSIGNED NOT NULL DEFAULT 14,
  suspend_days    INT UNSIGNED NOT NULL DEFAULT 30,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_public       TINYINT(1) NOT NULL DEFAULT 1,
  created_by      INT UNSIGNED DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_saas_plan_code (plan_code),
  KEY idx_saas_plan_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS saas_subscriptions (
  id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  subscription_no      VARCHAR(30) NOT NULL,
  tenant_id            INT UNSIGNED NOT NULL,
  plan_id              INT UNSIGNED DEFAULT NULL,
  plan_code            VARCHAR(30) DEFAULT NULL,
  plan_name            VARCHAR(150) NOT NULL,
  term                 VARCHAR(20) NOT NULL DEFAULT 'monthly',
  currency             VARCHAR(10) NOT NULL DEFAULT 'USD',
  amount               DECIMAL(14,2) NOT NULL DEFAULT 0,
  seats                INT UNSIGNED DEFAULT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'active',
  auto_renew           TINYINT(1) NOT NULL DEFAULT 1,
  cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
  trial_end_date       DATE DEFAULT NULL,
  start_date           DATE NOT NULL,
  current_period_start DATE NOT NULL,
  current_period_end   DATE NOT NULL,
  past_due_days        INT UNSIGNED NOT NULL DEFAULT 7,
  grace_days           INT UNSIGNED NOT NULL DEFAULT 14,
  suspend_days         INT UNSIGNED NOT NULL DEFAULT 30,
  renewal_count        INT UNSIGNED NOT NULL DEFAULT 0,
  last_payment_at      DATETIME DEFAULT NULL,
  canceled_at          DATETIME DEFAULT NULL,
  cancel_reason        VARCHAR(255) DEFAULT NULL,
  ended_at             DATETIME DEFAULT NULL,
  created_by           INT UNSIGNED DEFAULT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_saas_subscription_no (subscription_no),
  KEY idx_saas_subscriptions_tenant (tenant_id),
  KEY idx_saas_sub_status (status),
  KEY idx_saas_sub_period_end (current_period_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS saas_subscription_events (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       INT UNSIGNED NOT NULL,
  subscription_id INT UNSIGNED NOT NULL,
  subscription_no VARCHAR(30) DEFAULT NULL,
  event_type      VARCHAR(30) NOT NULL,
  from_status     VARCHAR(20) DEFAULT NULL,
  to_status       VARCHAR(20) DEFAULT NULL,
  amount          DECIMAL(14,2) DEFAULT NULL,
  currency        VARCHAR(10) DEFAULT NULL,
  period_start    DATE DEFAULT NULL,
  period_end      DATE DEFAULT NULL,
  note            VARCHAR(255) DEFAULT NULL,
  actor_id        INT UNSIGNED DEFAULT NULL,
  actor_name      VARCHAR(190) DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_saas_subscription_events_tenant (tenant_id),
  KEY idx_saas_evt_sub (subscription_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the default plan catalogue (idempotent on plan_code). Mirrors
-- seedDefaultPlans() in lib/billing/subscription-engine.ts.
INSERT INTO saas_plans
  (plan_code, name, description, currency, price_monthly, price_yearly, price_two_year, price_five_year,
   trial_days, seats, past_due_days, grace_days, suspend_days, is_active, is_public)
VALUES
  ('PLAN-STARTER',    'Starter',    'For small teams getting started with Muenot ERP.',                         'USD',  29,  290,   522,  1044, 14,   10,  7, 14, 30, 1, 1),
  ('PLAN-GROWTH',     'Growth',     'For scaling SMEs that need the full operations suite.',                     'USD',  99,  990,  1782,  3564, 14,   50,  7, 14, 30, 1, 1),
  ('PLAN-ENTERPRISE', 'Enterprise', 'For enterprises and MNCs with unlimited seats and priority support.',       'USD', 499, 4990,  8982, 17964, 30, NULL, 14, 30, 60, 1, 1)
ON DUPLICATE KEY UPDATE plan_code = plan_code;


-- ============================================================================
-- SPEC 17 â€” PLAN MANAGEMENT      (entitlements: lib/platform/entitlements.ts)
-- SPEC 18 â€” FEATURE ENTITLEMENTS (feature map: lib/platform/feature-entitlements.ts)
-- ----------------------------------------------------------------------------
-- The plan ENTITLEMENT contract (modules, users, employees, storage, API /
-- automation / job limits, reports, AI usage, integrations, support level,
-- feature flags) is stored as a JSON document on the platform plan catalogue
-- (`platform_plans.entitlements`), created by the platform-console migrations
-- and self-healed by lib/platform-console.ts. Feature-level states
-- (enabled / disabled / limited / metered) in SPEC 18 are DERIVED at runtime
-- from that JSON by lib/platform/feature-entitlements.ts and enforced
-- server-side by lib/platform/feature-guard.ts + entitlement-guard.ts â€” they
-- need no table of their own.
--
-- Guarded here so an install predating SPEC 17 gains the column. MySQL has no
-- "ADD COLUMN IF NOT EXISTS", so we add it only when absent.
SET @has_platform_plans := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'platform_plans'
);
SET @has_entitlements := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'platform_plans' AND column_name = 'entitlements'
);
SET @sql := IF(@has_platform_plans = 1 AND @has_entitlements = 0,
  'ALTER TABLE `platform_plans` ADD COLUMN `entitlements` JSON DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ============================================================================
-- SPEC 19 â€” USAGE METERING       (lib/billing/usage-metering.ts)
-- Per-tenant meters: active users, employees, storage, API requests, emails,
-- notifications, automation runs, jobs, AI usage, documents, bandwidth, etc.
-- ============================================================================

CREATE TABLE IF NOT EXISTS usage_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  meter_key VARCHAR(60) NOT NULL,
  quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  unit VARCHAR(20) NOT NULL DEFAULT 'unit',
  source VARCHAR(60) NULL,
  ref_id VARCHAR(80) NULL,
  metadata JSON NULL,
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_usage_events_meter (tenant_id, meter_key, occurred_at),
  KEY idx_usage_events_time (tenant_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usage_daily (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  meter_key VARCHAR(60) NOT NULL,
  usage_date DATE NOT NULL,
  quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  event_count INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_usage_daily (tenant_id, meter_key, usage_date),
  KEY idx_usage_daily_lookup (tenant_id, meter_key, usage_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usage_limits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  meter_key VARCHAR(60) NOT NULL,
  limit_value DECIMAL(18,4) NOT NULL DEFAULT 0,
  period VARCHAR(10) NOT NULL DEFAULT 'month',
  hard_limit TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_usage_limits (tenant_id, meter_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ============================================================================
-- SPEC 20 â€” BILLING ENGINE   (lib/billing/billing-engine.ts)
-- SPEC 23 â€” INVOICING        (invoices + bill_to_* details + credit notes)
-- Recurring & one-time charges, discounts, coupons, taxes, credits,
-- adjustments, refunds, proration, up/downgrade, renewal, invoice generation
-- and payment reconciliation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_coupons (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id        INT UNSIGNED NOT NULL,
  coupon_code      VARCHAR(40) NOT NULL,
  name             VARCHAR(150) NOT NULL,
  discount_type    VARCHAR(10) NOT NULL DEFAULT 'percent',
  value            DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency         VARCHAR(10) NOT NULL DEFAULT 'USD',
  duration         VARCHAR(12) NOT NULL DEFAULT 'once',
  duration_months  INT UNSIGNED DEFAULT NULL,
  min_amount       DECIMAL(14,2) DEFAULT NULL,
  max_redemptions  INT UNSIGNED DEFAULT NULL,
  times_redeemed   INT UNSIGNED NOT NULL DEFAULT 0,
  valid_from       DATE DEFAULT NULL,
  valid_until      DATE DEFAULT NULL,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_by       INT UNSIGNED DEFAULT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_coupon_code (tenant_id, coupon_code),
  KEY idx_billing_coupons_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- SPEC 23 invoice header. The bill_to_* / credit_note_of / last_sent_* columns
-- are declared inline here; the engine adds them idempotently on older installs.
CREATE TABLE IF NOT EXISTS billing_invoices (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_no       VARCHAR(30) NOT NULL,
  tenant_id        INT UNSIGNED NOT NULL,
  subscription_id  INT UNSIGNED DEFAULT NULL,
  customer_name    VARCHAR(190) NOT NULL DEFAULT '',
  invoice_type     VARCHAR(20) NOT NULL DEFAULT 'one_time',
  currency         VARCHAR(10) NOT NULL DEFAULT 'USD',
  subtotal         DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_total   DECIMAL(14,2) NOT NULL DEFAULT 0,
  coupon_code      VARCHAR(40) DEFAULT NULL,
  tax_rate         DECIMAL(7,4) NOT NULL DEFAULT 0,
  tax_total        DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit_applied   DECIMAL(14,2) NOT NULL DEFAULT 0,
  adjustment_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  total            DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount_paid      DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount_refunded  DECIMAL(14,2) NOT NULL DEFAULT 0,
  balance          DECIMAL(14,2) NOT NULL DEFAULT 0,
  status           VARCHAR(20) NOT NULL DEFAULT 'draft',
  issue_date       DATE NOT NULL,
  due_date         DATE DEFAULT NULL,
  period_start     DATE DEFAULT NULL,
  period_end       DATE DEFAULT NULL,
  memo             VARCHAR(500) DEFAULT NULL,
  bill_to_email    VARCHAR(190) DEFAULT NULL,
  bill_to_company  VARCHAR(190) DEFAULT NULL,
  bill_to_tax_id   VARCHAR(60) DEFAULT NULL,
  bill_to_address  VARCHAR(300) DEFAULT NULL,
  bill_to_city     VARCHAR(120) DEFAULT NULL,
  bill_to_state    VARCHAR(120) DEFAULT NULL,
  bill_to_postal   VARCHAR(30) DEFAULT NULL,
  bill_to_country  VARCHAR(120) DEFAULT NULL,
  credit_note_of   INT UNSIGNED DEFAULT NULL,
  last_sent_at     DATETIME DEFAULT NULL,
  last_sent_to     VARCHAR(190) DEFAULT NULL,
  created_by       INT UNSIGNED DEFAULT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_invoice_no (invoice_no),
  KEY idx_billing_invoices_tenant (tenant_id),
  KEY idx_billing_inv_status (status),
  KEY idx_billing_inv_sub (subscription_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_invoice_lines (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  invoice_id    INT UNSIGNED NOT NULL,
  line_type     VARCHAR(20) NOT NULL DEFAULT 'one_time',
  description   VARCHAR(300) NOT NULL DEFAULT '',
  quantity      DECIMAL(14,4) NOT NULL DEFAULT 1,
  unit_amount   DECIMAL(14,4) NOT NULL DEFAULT 0,
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  taxable       TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_billing_lines_tenant (tenant_id),
  KEY idx_billing_lines_invoice (invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_credits (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  credit_no     VARCHAR(30) NOT NULL,
  entry_type    VARCHAR(12) NOT NULL DEFAULT 'credit',
  reason        VARCHAR(300) NOT NULL DEFAULT '',
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
  invoice_id    INT UNSIGNED DEFAULT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'available',
  created_by    INT UNSIGNED DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_credit_no (credit_no),
  KEY idx_billing_credits_tenant (tenant_id),
  KEY idx_billing_credits_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_payments (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  payment_no    VARCHAR(30) NOT NULL,
  invoice_id    INT UNSIGNED NOT NULL,
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
  method        VARCHAR(20) NOT NULL DEFAULT 'manual',
  gateway       VARCHAR(40) DEFAULT NULL,
  reference     VARCHAR(120) DEFAULT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'succeeded',
  reconciled    TINYINT(1) NOT NULL DEFAULT 0,
  reconciled_at DATETIME DEFAULT NULL,
  paid_at       DATETIME DEFAULT NULL,
  note          VARCHAR(300) DEFAULT NULL,
  created_by    INT UNSIGNED DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_payment_no (payment_no),
  KEY idx_billing_payments_tenant (tenant_id),
  KEY idx_billing_pay_invoice (invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_refunds (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  refund_no     VARCHAR(30) NOT NULL,
  invoice_id    INT UNSIGNED NOT NULL,
  payment_id    INT UNSIGNED DEFAULT NULL,
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
  reason        VARCHAR(300) DEFAULT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'succeeded',
  refunded_at   DATETIME DEFAULT NULL,
  created_by    INT UNSIGNED DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_refund_no (refund_no),
  KEY idx_billing_refunds_tenant (tenant_id),
  KEY idx_billing_ref_invoice (invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_reconciliation (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  statement_ref VARCHAR(60) NOT NULL,
  gateway       VARCHAR(40) NOT NULL DEFAULT '',
  payout_ref    VARCHAR(120) DEFAULT NULL,
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
  payment_id    INT UNSIGNED DEFAULT NULL,
  invoice_no    VARCHAR(30) DEFAULT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'unmatched',
  reconciled_at DATETIME DEFAULT NULL,
  created_by    INT UNSIGNED DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_billing_recon_tenant (tenant_id),
  KEY idx_billing_recon_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ============================================================================
-- SPEC 21 â€” PAYMENT GATEWAY ABSTRACTION  (lib/billing/gateways/*)
-- ----------------------------------------------------------------------------
-- The provider abstraction (Razorpay, Stripe, future providers) is a code-level
-- adapter layer â€” a PaymentGateway interface, per-provider adapters and a
-- registry configured from environment variables (configureGatewaysFromEnv).
-- It deliberately holds NO business data of its own: a payment's chosen
-- provider is recorded on billing_payments.gateway / billing_reconciliation.gateway
-- and its inbound events on billing_gateway_events (SPEC 22 below). No table is
-- required for this spec.
-- ============================================================================


-- ============================================================================
-- SPEC 22 â€” PAYMENT WEBHOOKS  (lib/billing/gateways/webhook-service.ts)
-- Signature verification, idempotency, event storage, retry handling,
-- duplicate-event prevention, failed-event monitoring and reconciliation.
-- The UNIQUE (tenant_id, gateway, event_id) key is what enforces idempotency /
-- duplicate suppression.
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_gateway_events (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id    INT UNSIGNED NOT NULL,
  gateway      VARCHAR(40) NOT NULL,
  event_id     VARCHAR(191) NOT NULL,
  event_type   VARCHAR(60) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'processed',
  effect       VARCHAR(30) DEFAULT NULL,
  attempts     INT UNSIGNED NOT NULL DEFAULT 1,
  signature_ok TINYINT(1) NOT NULL DEFAULT 1,
  invoice_id   INT UNSIGNED DEFAULT NULL,
  payment_id   INT UNSIGNED DEFAULT NULL,
  last_error   VARCHAR(1000) DEFAULT NULL,
  reason       VARCHAR(255) DEFAULT NULL,
  raw          MEDIUMTEXT DEFAULT NULL,
  normalized   MEDIUMTEXT DEFAULT NULL,
  received_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gw_event (tenant_id, gateway, event_id),
  KEY idx_gw_event_tenant (tenant_id),
  KEY idx_gw_event_status (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ============================================================================
-- SPEC 24 â€” RENEWAL MANAGEMENT  (lib/billing/renewal-engine.ts)
-- Auto-renew, renewal reminders, failed-payment retries, grace periods,
-- suspension, expiry, manual renewal and renewal invoices.
-- ============================================================================

CREATE TABLE IF NOT EXISTS saas_renewal_reminders (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       INT UNSIGNED NOT NULL,
  subscription_id INT UNSIGNED NOT NULL,
  subscription_no VARCHAR(30) DEFAULT NULL,
  reminder_kind   VARCHAR(30) NOT NULL,
  period_end      DATE NOT NULL,
  due_date        DATE NOT NULL,
  channel         VARCHAR(20) NOT NULL DEFAULT 'log',
  status          VARCHAR(20) NOT NULL DEFAULT 'logged',
  recipient       VARCHAR(190) DEFAULT NULL,
  note            VARCHAR(255) DEFAULT NULL,
  sent_at         DATETIME DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_renewal_reminder (tenant_id, subscription_id, reminder_kind, period_end),
  KEY idx_renewal_reminder_tenant (tenant_id),
  KEY idx_renewal_reminder_sub (subscription_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS saas_renewal_attempts (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       INT UNSIGNED NOT NULL,
  subscription_id INT UNSIGNED NOT NULL,
  subscription_no VARCHAR(30) DEFAULT NULL,
  attempt_no      INT UNSIGNED NOT NULL DEFAULT 1,
  period_end      DATE NOT NULL,
  scheduled_for   DATE NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'failed',
  amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency        VARCHAR(10) NOT NULL DEFAULT 'USD',
  gateway         VARCHAR(40) DEFAULT NULL,
  invoice_no      VARCHAR(30) DEFAULT NULL,
  error           VARCHAR(255) DEFAULT NULL,
  processed_at    DATETIME DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_renewal_attempt (tenant_id, subscription_id, period_end, attempt_no),
  KEY idx_renewal_attempt_tenant (tenant_id),
  KEY idx_renewal_attempt_sub (subscription_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ============================================================================
-- SPEC 25 â€” CUSTOMER BILLING PORTAL  (app/api/billing/portal + components/billing/customer-portal-console.tsx)
-- ----------------------------------------------------------------------------
-- The tenant-admin portal (current plan, usage, billing cycle, invoices,
-- payment methods, payment history, renewal date, upgrade/downgrade,
-- cancellation, credits) is a READ/aggregate surface over the tables above:
--   â€¢ plan / cycle / renewal â†’ saas_subscriptions + saas_plans
--   â€¢ usage                  â†’ usage_daily / usage_events / usage_limits
--   â€¢ invoices / payments    â†’ billing_invoices / billing_payments
--   â€¢ credits                â†’ billing_credits
--   â€¢ payment methods        â†’ provider-held (gateway abstraction, SPEC 21)
-- It introduces no tables of its own; all reads are tenant-scoped via billingGuard.
-- ============================================================================



-- FILE: 2026-11-18-add-storage-module.sql
-- =============================================================
-- Storage Module â€” SPEC 26â€“36
-- =============================================================
-- Consolidated schema for the customer-owned storage module. Every table here
-- is otherwise self-healed at runtime by the lib/storage/* `ensure*Schema()`
-- helpers (CREATE TABLE IF NOT EXISTS); this migration documents the canonical
-- shape and lets a fresh database be provisioned up front.
--
-- All tables are tenant-owned and accessed only through the tenant-scope
-- helpers (lib/tenant-scope.ts, lib/tenant-tables.ts), so every read/write is
-- isolated per tenant. Secrets (S3 secret keys) are encrypted at rest.
--
-- Idempotent: safe to run repeatedly and safe to run after runtime auto-heal.
-- =============================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- -------------------------------------------------------------
-- SPEC 26 / 27 â€” Customer storage connections + secure config + audit
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_storage_connections (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  provider VARCHAR(40) NOT NULL,
  name VARCHAR(190) NOT NULL,
  bucket VARCHAR(255) NOT NULL,
  region VARCHAR(120) DEFAULT NULL,
  endpoint VARCHAR(500) DEFAULT NULL,
  access_key_id VARCHAR(255) DEFAULT NULL,
  secret_access_key TEXT DEFAULT NULL,
  force_path_style TINYINT(1) NOT NULL DEFAULT 0,
  public_base_url VARCHAR(500) DEFAULT NULL,
  path_prefix VARCHAR(500) DEFAULT NULL,
  server_side_encryption VARCHAR(40) NOT NULL DEFAULT 'none',
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tsc_tenant (tenant_id),
  KEY idx_tsc_active (tenant_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tenant_storage_audit (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  connection_id BIGINT DEFAULT NULL,
  action VARCHAR(40) NOT NULL,
  detail VARCHAR(500) DEFAULT NULL,
  user_id INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tsca_tenant (tenant_id),
  KEY idx_tsca_conn (connection_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Storage â†’ module/sub-module folder mappings (migration panel)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_storage_migrations (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  module_key VARCHAR(80) NOT NULL,
  module_label VARCHAR(190) NOT NULL,
  submodule_key VARCHAR(120) NOT NULL,
  submodule_label VARCHAR(190) NOT NULL,
  connection_id BIGINT DEFAULT NULL,
  folder VARCHAR(500) NOT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tsm_target (tenant_id, module_key, submodule_key),
  KEY idx_tsm_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 32 â€” Centralized file metadata (normalized per-object model)
-- SPEC 36 â€” retention_override column lives on this table
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_objects (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  file_ref VARCHAR(40) NOT NULL,
  owner_id INT DEFAULT NULL,
  module VARCHAR(60) NOT NULL,
  entity_type VARCHAR(80) DEFAULT NULL,
  entity_id VARCHAR(120) DEFAULT NULL,
  object_key VARCHAR(1024) NOT NULL,
  provider VARCHAR(40) NOT NULL,
  filename VARCHAR(500) DEFAULT NULL,
  mime_type VARCHAR(255) DEFAULT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  checksum_sha256 CHAR(64) DEFAULT NULL,
  upload_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  is_current TINYINT(1) NOT NULL DEFAULT 1,
  supersedes_id BIGINT DEFAULT NULL,
  classification VARCHAR(20) NOT NULL DEFAULT 'internal',
  retention_policy VARCHAR(30) NOT NULL DEFAULT 'default',
  retention_expires_at DATETIME DEFAULT NULL,
  retention_override TINYINT(1) NOT NULL DEFAULT 0,
  legal_hold TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME DEFAULT NULL,
  deleted_by INT DEFAULT NULL,
  UNIQUE KEY uq_fo_tenant_key (tenant_id, object_key),
  UNIQUE KEY uq_fo_tenant_ref (tenant_id, file_ref),
  KEY idx_fo_tenant (tenant_id),
  KEY idx_fo_entity (tenant_id, module, entity_type, entity_id),
  KEY idx_fo_status (tenant_id, upload_status),
  KEY idx_fo_checksum (tenant_id, checksum_sha256),
  KEY idx_fo_retention (retention_expires_at),
  KEY idx_fo_current (tenant_id, is_current)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 33 â€” File / document version audit trail
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_version_audit (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  file_id BIGINT NOT NULL,
  file_ref VARCHAR(40) DEFAULT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  action VARCHAR(20) NOT NULL,
  detail VARCHAR(500) DEFAULT NULL,
  user_id INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_fva_tenant (tenant_id),
  KEY idx_fva_file (tenant_id, file_id),
  KEY idx_fva_action (tenant_id, action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 34 â€” Malware / file-security scanning
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_security_scans (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  file_id BIGINT NOT NULL,
  file_ref VARCHAR(40) DEFAULT NULL,
  object_key VARCHAR(1024) NOT NULL,
  scan_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  safety VARCHAR(12) NOT NULL DEFAULT 'unknown',
  quarantine_status VARCHAR(16) NOT NULL DEFAULT 'quarantined',
  provider VARCHAR(60) DEFAULT NULL,
  findings TEXT DEFAULT NULL,
  detail VARCHAR(500) DEFAULT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  approved TINYINT(1) NOT NULL DEFAULT 0,
  approved_by INT DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  requested_by INT DEFAULT NULL,
  scanned_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fss_tenant_file (tenant_id, file_id),
  KEY idx_fss_tenant (tenant_id),
  KEY idx_fss_status (tenant_id, scan_status),
  KEY idx_fss_quarantine (tenant_id, quarantine_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 30 â€” Large / resumable multipart upload sessions + parts
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_upload_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  upload_id VARCHAR(1024) NOT NULL,
  storage_key VARCHAR(1024) NOT NULL,
  provider VARCHAR(40) NOT NULL,
  filename VARCHAR(500) NOT NULL,
  content_type VARCHAR(255) DEFAULT NULL,
  total_size BIGINT NOT NULL DEFAULT 0,
  part_size BIGINT NOT NULL DEFAULT 0,
  total_parts INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  category VARCHAR(40) NOT NULL DEFAULT 'other',
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_sus_tenant (tenant_id),
  KEY idx_sus_status (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS storage_upload_parts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  session_id BIGINT NOT NULL,
  part_number INT NOT NULL,
  etag VARCHAR(512) NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sup_session_part (session_id, part_number),
  KEY idx_sup_tenant (tenant_id),
  KEY idx_sup_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 35 â€” Tenant storage quota settings
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_quota_settings (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  custom_quota_bytes BIGINT DEFAULT NULL,
  warn_threshold_percent TINYINT UNSIGNED NOT NULL DEFAULT 80,
  hard_limit TINYINT(1) NOT NULL DEFAULT 0,
  enforced TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sqs_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- SPEC 36 â€” Configurable retention: default settings + per-module rules
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_retention_settings (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  default_mode VARCHAR(12) NOT NULL DEFAULT 'duration',
  default_amount INT UNSIGNED NOT NULL DEFAULT 7,
  default_unit VARCHAR(8) NOT NULL DEFAULT 'years',
  auto_cleanup_enabled TINYINT(1) NOT NULL DEFAULT 0,
  last_run_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_srs_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS storage_retention_rules (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  module VARCHAR(60) NOT NULL,
  mode VARCHAR(12) NOT NULL DEFAULT 'duration',
  amount INT UNSIGNED NOT NULL DEFAULT 7,
  unit VARCHAR(8) NOT NULL DEFAULT 'years',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_srr_tenant_module (tenant_id, module),
  KEY idx_srr_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-11-19-whatsapp-multi-tenant-isolation.sql
-- =============================================================
-- Migration: WhatsApp Business multi-tenant data isolation
-- Run in phpMyAdmin (Hostinger) AFTER
--   2026-09-20-add-whatsapp-messaging.sql
--   2026-09-21-add-whatsapp-shared-inbox.sql
--   2026-09-22-add-whatsapp-platform.sql
--   2026-11-07-tenant-data-isolation.sql
--
-- PURPOSE
--   The WhatsApp platform was built single-tenant: one global integration row,
--   and contacts/conversations/messages/campaigns/etc. that any tenant could
--   read. This migration scopes EVERY WhatsApp table to a tenant so each
--   customer organization only ever sees its own WhatsApp data, and adds an
--   `integration_id` so a tenant can connect more than one WhatsApp Business
--   number without the rows colliding.
--
-- WHAT IT DOES (all additive + idempotent)
--   1. Adds `tenant_id` to every WhatsApp table (mirrors lib/tenant-tables.ts;
--      the generic self-heal in lib/tenant-ensure.ts also adds this at runtime).
--   2. Adds `integration_id` to the data tables that hang off a connected
--      number (contacts, conversations, messages, webhook_events, campaigns,
--      templates, media).
--   3. Backfills tenant_id only when an existing ERP ownership relationship
--      proves the owner; ambiguous legacy rows remain NULL for administrator
--      mapping instead of being assigned to an arbitrary tenant.
--   4. Replaces globally-unique keys with tenant-scoped composite unique keys
--      so two tenants can legitimately hold the same phone number / wamid /
--      template name without a collision.
--
-- IDEMPOTENT: uses IF NOT EXISTS / IF EXISTS (MariaDB 10.x, which Hostinger
-- runs). Safe to run more than once. lib/whatsapp.ts, lib/whatsapp-store.ts and
-- lib/whatsapp-platform.ts mirror this at runtime so a deployment that has not
-- imported this SQL yet still isolates correctly.
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Resolve only ownership that is proven by existing ERP relationships. Legacy
-- rows without a provable owner intentionally remain NULL and are unavailable
-- to tenant APIs until an administrator maps them; never guess the first tenant.
-- -------------------------------------------------------------
SET @default_tenant := NULL;

-- =============================================================
-- 1. marketing_whatsapp_integration
-- =============================================================
ALTER TABLE `marketing_whatsapp_integration`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_integration` i
JOIN `users` u ON u.`id` = i.`connected_by_user_id` AND u.`tenant_id` IS NOT NULL
SET i.`tenant_id` = u.`tenant_id`
WHERE i.`tenant_id` IS NULL;
UPDATE `marketing_whatsapp_integration` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_integration`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_integration_tenant` (`tenant_id`);
-- A number is unique WITHIN a tenant, not globally.
ALTER TABLE `marketing_whatsapp_integration` DROP INDEX IF EXISTS `uniq_phone_number`;
ALTER TABLE `marketing_whatsapp_integration`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_integration_tenant_phone` (`tenant_id`, `phone_number_id`);

-- =============================================================
-- 2. marketing_whatsapp_contacts
-- =============================================================
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_contacts` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_contacts` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_contacts_tenant` (`tenant_id`);
-- Phone is unique per (tenant, number), so two tenants can talk to the same
-- customer independently.
ALTER TABLE `marketing_whatsapp_contacts` DROP INDEX IF EXISTS `uniq_wa_contact_phone`;
ALTER TABLE `marketing_whatsapp_contacts`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_contact_tenant_phone` (`tenant_id`, `phone_number`);

-- =============================================================
-- 3. marketing_whatsapp_conversations
-- =============================================================
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_conversations` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_conversations` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_conversations_tenant` (`tenant_id`);
-- A foreign key on `contact_id` is backed by the old unique index, so MariaDB
-- refuses to drop it (#1553). Add a standalone index on `contact_id` FIRST so
-- the FK has another index to lean on, THEN the old unique key is free to drop.
ALTER TABLE `marketing_whatsapp_conversations`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_conversations_contact` (`contact_id`);
ALTER TABLE `marketing_whatsapp_conversations` DROP INDEX IF EXISTS `uniq_wa_convo_contact_number`;
ALTER TABLE `marketing_whatsapp_conversations`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_convo_tenant_contact_number` (`tenant_id`, `contact_id`, `phone_number_id`);

-- =============================================================
-- 4. marketing_whatsapp_messages
-- =============================================================
ALTER TABLE `marketing_whatsapp_messages`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_messages`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_messages` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_messages` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_messages`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_messages_tenant` (`tenant_id`);
-- wamid stays idempotent, but scoped to the tenant so two tenants can never
-- clash and one tenant can never update another's message by wamid.
ALTER TABLE `marketing_whatsapp_messages` DROP INDEX IF EXISTS `uniq_wa_message_wamid`;
ALTER TABLE `marketing_whatsapp_messages`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_message_tenant_wamid` (`tenant_id`, `wamid`);

-- =============================================================
-- 5. marketing_whatsapp_webhook_events
-- =============================================================
ALTER TABLE `marketing_whatsapp_webhook_events`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_webhook_events`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_webhook_events` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_webhook_events` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_webhook_events`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_webhook_events_tenant` (`tenant_id`);
ALTER TABLE `marketing_whatsapp_webhook_events` DROP INDEX IF EXISTS `uniq_wa_event_dedup`;
ALTER TABLE `marketing_whatsapp_webhook_events`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_event_tenant_dedup` (`tenant_id`, `dedup_key`);

-- =============================================================
-- 6. marketing_whatsapp_assignments
-- =============================================================
ALTER TABLE `marketing_whatsapp_assignments`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_assignments` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_assignments`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_assignments_tenant` (`tenant_id`);

-- =============================================================
-- 7. marketing_whatsapp_departments
-- =============================================================
ALTER TABLE `marketing_whatsapp_departments`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_departments` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_departments`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_departments_tenant` (`tenant_id`);
-- Slug is unique per tenant, so each tenant gets its own "sales"/"support" desk.
ALTER TABLE `marketing_whatsapp_departments` DROP INDEX IF EXISTS `uniq_wa_dept_slug`;
ALTER TABLE `marketing_whatsapp_departments`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_dept_tenant_slug` (`tenant_id`, `slug`);

-- =============================================================
-- 8. marketing_whatsapp_department_agents
-- =============================================================
ALTER TABLE `marketing_whatsapp_department_agents`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_department_agents` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_department_agents`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_department_agents_tenant` (`tenant_id`);

-- =============================================================
-- 9. marketing_whatsapp_agent_settings
-- =============================================================
ALTER TABLE `marketing_whatsapp_agent_settings`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `user_id`;
UPDATE `marketing_whatsapp_agent_settings` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_agent_settings`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_agent_settings_tenant` (`tenant_id`);

-- =============================================================
-- 10. marketing_whatsapp_internal_notes
-- =============================================================
ALTER TABLE `marketing_whatsapp_internal_notes`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_internal_notes` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_internal_notes`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_internal_notes_tenant` (`tenant_id`);

-- =============================================================
-- 11. marketing_whatsapp_transfers
-- =============================================================
ALTER TABLE `marketing_whatsapp_transfers`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_transfers` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_transfers`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_transfers_tenant` (`tenant_id`);

-- =============================================================
-- 12. marketing_whatsapp_media
-- =============================================================
ALTER TABLE `marketing_whatsapp_media`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_media`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_media` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_media` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_media`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_media_tenant` (`tenant_id`);
ALTER TABLE `marketing_whatsapp_media` DROP INDEX IF EXISTS `uniq_wa_media_id`;
ALTER TABLE `marketing_whatsapp_media`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_media_tenant_id` (`tenant_id`, `media_id`);

-- =============================================================
-- 13. marketing_whatsapp_templates
-- =============================================================
ALTER TABLE `marketing_whatsapp_templates`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_templates`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_templates` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_templates` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_templates`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_templates_tenant` (`tenant_id`);
ALTER TABLE `marketing_whatsapp_templates` DROP INDEX IF EXISTS `uniq_wa_template`;
ALTER TABLE `marketing_whatsapp_templates` DROP INDEX IF EXISTS `uniq_wa_template_tenant`;
ALTER TABLE `marketing_whatsapp_templates`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_wa_template_tenant_integration` (`tenant_id`, `integration_id`, `name`, `language`);

-- =============================================================
-- 14. marketing_whatsapp_template_versions
-- =============================================================
ALTER TABLE `marketing_whatsapp_template_versions`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_template_versions`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
ALTER TABLE `marketing_whatsapp_template_versions`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_template_versions_tenant` (`tenant_id`);

-- =============================================================
-- 15. marketing_whatsapp_audiences
-- =============================================================
ALTER TABLE `marketing_whatsapp_audiences`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
UPDATE `marketing_whatsapp_audiences` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_audiences`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_audiences_tenant` (`tenant_id`);

-- =============================================================
-- 16. marketing_whatsapp_campaigns
-- =============================================================
ALTER TABLE `marketing_whatsapp_campaigns`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_campaigns`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_campaigns` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
UPDATE `marketing_whatsapp_campaigns` SET `integration_id` = @legacy_integration WHERE `integration_id` IS NULL AND @legacy_integration IS NOT NULL;
ALTER TABLE `marketing_whatsapp_campaigns`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_campaigns_tenant` (`tenant_id`);

-- =============================================================
-- 17. marketing_whatsapp_campaign_recipients
-- =============================================================
ALTER TABLE `marketing_whatsapp_campaign_recipients`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_campaign_recipients`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_campaign_recipients` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_campaign_recipients`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_campaign_recipients_tenant` (`tenant_id`);

-- =============================================================
-- 18. marketing_whatsapp_campaign_events
-- =============================================================
ALTER TABLE `marketing_whatsapp_campaign_events`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_campaign_events`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_campaign_events` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_campaign_events`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_campaign_events_tenant` (`tenant_id`);

-- =============================================================
-- 19. marketing_whatsapp_automations
-- =============================================================
ALTER TABLE `marketing_whatsapp_automations`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_automations`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
UPDATE `marketing_whatsapp_automations` SET `tenant_id` = @default_tenant WHERE `tenant_id` IS NULL AND @default_tenant IS NOT NULL;
ALTER TABLE `marketing_whatsapp_automations`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_automations_tenant` (`tenant_id`);

-- Diagnostics are tenant-owned as well; an unmapped legacy row stays NULL and
-- is never returned by a normal tenant query. The table may be runtime-created
-- on older deployments, so create the compatible shape before altering it.
CREATE TABLE IF NOT EXISTS `marketing_whatsapp_diagnostics` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `integration_id` INT UNSIGNED DEFAULT NULL,
  `direction` VARCHAR(16) NOT NULL,
  `outcome` VARCHAR(16) NOT NULL,
  `context` VARCHAR(64) NOT NULL,
  `phone_number` VARCHAR(32) DEFAULT NULL,
  `wamid` VARCHAR(191) DEFAULT NULL,
  `template_name` VARCHAR(191) DEFAULT NULL,
  `campaign_id` INT UNSIGNED DEFAULT NULL,
  `error_code` INT DEFAULT NULL,
  `retryable` TINYINT(1) DEFAULT NULL,
  `message` VARCHAR(1000) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE `marketing_whatsapp_diagnostics`
  ADD COLUMN IF NOT EXISTS `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`;
ALTER TABLE `marketing_whatsapp_diagnostics`
  ADD COLUMN IF NOT EXISTS `integration_id` INT UNSIGNED DEFAULT NULL AFTER `tenant_id`;
ALTER TABLE `marketing_whatsapp_diagnostics`
  ADD KEY IF NOT EXISTS `idx_marketing_whatsapp_diagnostics_tenant` (`tenant_id`);



-- FILE: 2026-11-20-security-sessions-sso.sql
-- SPEC 61 / 56-58 â€” Server-side session store + SSO (OIDC/SAML) identity providers.
--
-- Documents the schema that lib/session-store.ts and lib/sso-store.ts also
-- self-heal at runtime (same pattern as lib/secrets/store.ts and
-- lib/tenant-ensure.ts), so a fresh database converges without running this
-- file manually and an existing one can apply it directly.

CREATE TABLE IF NOT EXISTS `user_sessions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` VARCHAR(64) NOT NULL,
  `user_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `ip_address` VARCHAR(64) DEFAULT NULL,
  `user_agent` VARCHAR(500) DEFAULT NULL,
  `login_method` VARCHAR(20) NOT NULL DEFAULT 'password',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_active_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME NOT NULL,
  `revoked_at` DATETIME DEFAULT NULL,
  `revoked_reason` VARCHAR(60) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_user_sessions_session_id` (`session_id`),
  KEY `idx_user_sessions_user` (`user_id`),
  KEY `idx_user_sessions_tenant` (`tenant_id`),
  CONSTRAINT `fk_user_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sso_providers` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `type` ENUM('oidc','saml') NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `status` ENUM('draft','enabled','disabled') NOT NULL DEFAULT 'draft',
  `domains` VARCHAR(255) DEFAULT NULL,
  `auto_provision` TINYINT(1) NOT NULL DEFAULT 1,
  `default_role` ENUM('admin','employee') NOT NULL DEFAULT 'employee',
  `issuer_url` VARCHAR(255) DEFAULT NULL,
  `discovery_url` VARCHAR(255) DEFAULT NULL,
  `authorization_endpoint` VARCHAR(255) DEFAULT NULL,
  `token_endpoint` VARCHAR(255) DEFAULT NULL,
  `userinfo_endpoint` VARCHAR(255) DEFAULT NULL,
  `jwks_uri` VARCHAR(255) DEFAULT NULL,
  `client_id` VARCHAR(255) DEFAULT NULL,
  `client_secret_encrypted` TEXT DEFAULT NULL,
  `scopes` VARCHAR(255) DEFAULT 'openid email profile',
  `entity_id` VARCHAR(255) DEFAULT NULL,
  `sso_url` VARCHAR(255) DEFAULT NULL,
  `certificate` TEXT DEFAULT NULL,
  `email_attribute` VARCHAR(120) DEFAULT NULL,
  `first_name_attribute` VARCHAR(120) DEFAULT NULL,
  `last_name_attribute` VARCHAR(120) DEFAULT NULL,
  `employee_id_attribute` VARCHAR(120) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_login_at` DATETIME DEFAULT NULL,
  `last_test_at` DATETIME DEFAULT NULL,
  `last_test_ok` TINYINT(1) DEFAULT NULL,
  `last_test_message` VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sso_providers_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sso_login_events` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `user_id` INT UNSIGNED DEFAULT NULL,
  `email` VARCHAR(190) DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL,
  `message` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sso_login_events_provider` (`provider_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sso_identities` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT, `provider_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED DEFAULT NULL, `user_id` INT UNSIGNED NOT NULL, `subject` VARCHAR(255) NOT NULL,
  `email_at_link` VARCHAR(190) DEFAULT NULL, `deprovisioned_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), UNIQUE KEY `uniq_sso_identity_subject` (`provider_id`,`subject`),
  UNIQUE KEY `uniq_sso_identity_user` (`provider_id`,`user_id`), KEY `idx_sso_identity_tenant` (`tenant_id`,`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sso_saml_requests` (
  `request_id` VARCHAR(255) NOT NULL, `provider_id` INT UNSIGNED NOT NULL, `request_xml` MEDIUMTEXT NOT NULL, `expires_at` DATETIME NOT NULL,
  PRIMARY KEY (`request_id`), KEY `idx_sso_saml_request_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-11-27-api-keys-webhooks.sql
-- =============================================================
-- SPEC 67-70 â€” API Key platform + Webhook delivery engine.
-- Self-created at runtime by lib/api-keys-store.ts / lib/webhooks-store.ts
-- (ensureApiKeysSchema / ensureWebhooksSchema). This file documents the
-- shape for manual phpMyAdmin imports on installs that prefer to run
-- migrations up front instead of relying on the runtime self-heal.
-- =============================================================

CREATE TABLE IF NOT EXISTS `api_keys` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `key_prefix` VARCHAR(16) NOT NULL,
  `key_hash` VARCHAR(64) NOT NULL,
  `scopes` VARCHAR(255) NOT NULL DEFAULT '',
  `status` ENUM('active','revoked') NOT NULL DEFAULT 'active',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` DATETIME DEFAULT NULL,
  `expires_at` DATETIME DEFAULT NULL,
  `revoked_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_api_keys_hash` (`key_hash`),
  KEY `idx_api_keys_tenant` (`tenant_id`),
  KEY `idx_api_keys_prefix` (`key_prefix`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `webhook_endpoints` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `events` VARCHAR(500) NOT NULL DEFAULT '',
  `secret_encrypted` TEXT DEFAULT NULL,
  `status` ENUM('active','disabled') NOT NULL DEFAULT 'active',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_delivery_at` DATETIME DEFAULT NULL,
  `last_delivery_ok` TINYINT(1) DEFAULT NULL,
  `failure_count` INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_webhook_endpoints_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `webhook_deliveries` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `endpoint_id` INT UNSIGNED NOT NULL,
  `tenant_id` INT UNSIGNED NOT NULL,
  `event_type` VARCHAR(80) NOT NULL,
  `payload` MEDIUMTEXT NOT NULL,
  `status` ENUM('pending','success','failed') NOT NULL DEFAULT 'pending',
  `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `response_code` INT DEFAULT NULL,
  `response_body` VARCHAR(500) DEFAULT NULL,
  `next_retry_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `delivered_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_webhook_deliveries_endpoint` (`endpoint_id`),
  KEY `idx_webhook_deliveries_tenant` (`tenant_id`),
  KEY `idx_webhook_deliveries_retry` (`status`, `next_retry_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- FILE: 2026-11-28-ip-allowlist.sql
-- SPEC 62 â€” IP allowlisting for sign-in.
--
-- Documents the schema that lib/ip-allowlist-store.ts also self-heals at
-- runtime (same pattern as lib/session-store.ts and lib/secrets/store.ts),
-- so a fresh database converges without running this file manually and an
-- existing one can apply it directly.

CREATE TABLE IF NOT EXISTS `ip_allowlist_entries` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `label` VARCHAR(120) NOT NULL,
  `cidr` VARCHAR(64) NOT NULL,
  `mode` ENUM('allow','block') NOT NULL DEFAULT 'allow',
  `scope` ENUM('all','admin') NOT NULL DEFAULT 'all',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_matched_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ip_allowlist_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



