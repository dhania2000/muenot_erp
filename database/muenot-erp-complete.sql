-- Muenot ERP consolidated database SQL
-- Import schema.sql first, followed by migrations in filename order.
-- Generated from database/schema.sql and database/migrations/*.sql.

-- ==================== schema.sql ====================

-- =============================================================
-- Employee Management System — MySQL Schema
-- Import this file in phpMyAdmin (Hostinger) to set up the database.
-- Modules: HR, Sales, Finance, Recruitment, Operations
-- =============================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET FOREIGN_KEY_CHECKS = 0;

-- -------------------------------------------------------------
-- Table: users
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(150) NOT NULL,
  `email` VARCHAR(190) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('admin','employee') NOT NULL DEFAULT 'employee',
  `designation` VARCHAR(120) DEFAULT NULL,
  `status` ENUM('active','inactive') NOT NULL DEFAULT 'active',
  `must_change_password` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: modules
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `modules`;
CREATE TABLE `modules` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `slug` VARCHAR(100) NOT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `icon` VARCHAR(50) DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_modules_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: features (individual permissions inside a module)
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `features`;
CREATE TABLE `features` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `module_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `slug` VARCHAR(150) NOT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_feature_slug` (`slug`),
  KEY `idx_features_module` (`module_id`),
  CONSTRAINT `fk_features_module` FOREIGN KEY (`module_id`) REFERENCES `modules` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: user_permissions (which feature a user can access)
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `user_permissions`;
CREATE TABLE `user_permissions` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `feature_id` INT UNSIGNED NOT NULL,
  `granted_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_user_feature` (`user_id`, `feature_id`),
  KEY `idx_perm_user` (`user_id`),
  KEY `idx_perm_feature` (`feature_id`),
  CONSTRAINT `fk_perm_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_perm_feature` FOREIGN KEY (`feature_id`) REFERENCES `features` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_perm_granted_by` FOREIGN KEY (`granted_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: environment_variables
-- -------------------------------------------------------------
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

-- -------------------------------------------------------------
-- Table: sales_leads
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `sales_leads`;
CREATE TABLE `sales_leads` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lead_code` VARCHAR(30) NOT NULL,
  `lead_date` DATE DEFAULT NULL,
  `contact_person` VARCHAR(150) DEFAULT NULL,
  `contact_number` VARCHAR(40) DEFAULT NULL,
  `email` VARCHAR(190) DEFAULT NULL,
  `designation` VARCHAR(150) DEFAULT NULL,
  `source_url` VARCHAR(500) DEFAULT NULL,
  `lead_source` VARCHAR(80) DEFAULT NULL,
  `company_name` VARCHAR(190) DEFAULT NULL,
  `industry` VARCHAR(100) DEFAULT NULL,
  `website` VARCHAR(190) DEFAULT NULL,
  `company_email` VARCHAR(190) DEFAULT NULL,
  `country` VARCHAR(100) DEFAULT NULL,
  `assigned_to` INT UNSIGNED DEFAULT NULL,
  `status` ENUM('New','Follow Up 1','Follow Up 2','In Discussion','Proposal Sent','Ready','Won','Lost') NOT NULL DEFAULT 'New',
  `lead_status` ENUM('Open','Won','Lost','Follow Up') NOT NULL DEFAULT 'Open',
  `follow_up_date` DATETIME DEFAULT NULL,
  `last_contact_date` DATETIME DEFAULT NULL,
  `lead_health_score` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `remarks` TEXT DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_lead_code` (`lead_code`),
  KEY `idx_leads_status` (`status`),
  KEY `idx_leads_lead_status` (`lead_status`),
  KEY `idx_leads_assigned` (`assigned_to`),
  CONSTRAINT `fk_leads_assigned` FOREIGN KEY (`assigned_to`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_leads_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: sales_companies
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `sales_companies`;
CREATE TABLE `sales_companies` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `company_code` VARCHAR(30) NOT NULL,
  `company_date` DATE DEFAULT NULL,
  `company_name` VARCHAR(190) NOT NULL,
  `industry` VARCHAR(100) DEFAULT NULL,
  `website` VARCHAR(190) DEFAULT NULL,
  `linkedin_url` VARCHAR(190) DEFAULT NULL,
  `company_email` VARCHAR(190) DEFAULT NULL,
  `country` VARCHAR(150) DEFAULT NULL,
  `assigned_to` INT UNSIGNED DEFAULT NULL,
  `company_type` VARCHAR(80) DEFAULT NULL,
  `status` ENUM('New','Contacted','Qualified','Inactive') NOT NULL DEFAULT 'New',
  `priority` ENUM('Low','Medium','High') DEFAULT NULL,
  `founded_year` SMALLINT UNSIGNED DEFAULT NULL,
  `employee_count` INT UNSIGNED DEFAULT NULL,
  `last_contact_date` DATE DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_company_code` (`company_code`),
  KEY `idx_companies_status` (`status`),
  CONSTRAINT `fk_companies_assigned` FOREIGN KEY (`assigned_to`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_companies_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: sales_meetings
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `sales_meetings`;
CREATE TABLE `sales_meetings` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `meeting_code` VARCHAR(30) NOT NULL,
  `meeting_date` DATE DEFAULT NULL,
  `meeting_time` TIME DEFAULT NULL,
  `company_name` VARCHAR(190) DEFAULT NULL,
  `contact_person` VARCHAR(150) DEFAULT NULL,
  `meeting_type` ENUM('Discovery','Demo','Negotiation','Review','Other') NOT NULL DEFAULT 'Discovery',
  `agenda` VARCHAR(255) DEFAULT NULL,
  `outcome_notes` TEXT DEFAULT NULL,
  `next_steps` VARCHAR(255) DEFAULT NULL,
  `added_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_meeting_code` (`meeting_code`),
  CONSTRAINT `fk_meetings_added_by` FOREIGN KEY (`added_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: sales_quotations
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `sales_quotations`;
CREATE TABLE `sales_quotations` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `quote_code` VARCHAR(30) NOT NULL,
  `quote_date` DATE DEFAULT NULL,
  `company_name` VARCHAR(190) DEFAULT NULL,
  `contact_person` VARCHAR(150) DEFAULT NULL,
  `opportunity_name` VARCHAR(190) DEFAULT NULL,
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `valid_until` DATE DEFAULT NULL,
  `status` ENUM('Draft','Sent','Accepted','Rejected','Expired') NOT NULL DEFAULT 'Draft',
  `added_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_quote_code` (`quote_code`),
  CONSTRAINT `fk_quotations_added_by` FOREIGN KEY (`added_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: sales_contracts
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `sales_contracts`;
CREATE TABLE `sales_contracts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `contract_code` VARCHAR(30) NOT NULL,
  `contract_date` DATE DEFAULT NULL,
  `company_name` VARCHAR(190) DEFAULT NULL,
  `start_date` DATE DEFAULT NULL,
  `end_date` DATE DEFAULT NULL,
  `value` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `contract_type` VARCHAR(80) DEFAULT NULL,
  `status` ENUM('Active','Expired','Terminated','Draft') NOT NULL DEFAULT 'Draft',
  `signed_by_client` VARCHAR(150) DEFAULT NULL,
  `signed_by_company` VARCHAR(150) DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `added_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_contract_code` (`contract_code`),
  CONSTRAINT `fk_contracts_added_by` FOREIGN KEY (`added_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: sales_onboarding
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `sales_onboarding`;
CREATE TABLE `sales_onboarding` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `onboarding_code` VARCHAR(30) NOT NULL,
  `onboarding_date` DATE DEFAULT NULL,
  `company_name` VARCHAR(190) DEFAULT NULL,
  `contract_code` VARCHAR(30) DEFAULT NULL,
  `start_date` DATE DEFAULT NULL,
  `kickoff_meeting_date` DATE DEFAULT NULL,
  `current_stage` ENUM('Kickoff','Setup','Training','Integration','Completed') NOT NULL DEFAULT 'Kickoff',
  `status` ENUM('Not Started','In Progress','Completed','On Hold') NOT NULL DEFAULT 'Not Started',
  `onboarding_by` VARCHAR(150) DEFAULT NULL,
  `added_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_onboarding_code` (`onboarding_code`),
  CONSTRAINT `fk_onboarding_added_by` FOREIGN KEY (`added_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: sales_revenue_forecast
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `sales_revenue_forecast`;
CREATE TABLE `sales_revenue_forecast` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `forecast_code` VARCHAR(30) NOT NULL,
  `forecast_date` DATE DEFAULT NULL,
  `quarter` VARCHAR(10) DEFAULT NULL,
  `year` SMALLINT UNSIGNED DEFAULT NULL,
  `expected_revenue` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `best_case` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `worst_case` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `pipeline_coverage` VARCHAR(20) DEFAULT NULL,
  `owner` VARCHAR(150) DEFAULT NULL,
  `added_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_forecast_code` (`forecast_code`),
  CONSTRAINT `fk_forecast_added_by` FOREIGN KEY (`added_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- =============================================================
-- Seed data
-- =============================================================

-- Default admin account
-- email: admin@company.com
-- password: Admin@123  (CHANGE THIS AFTER FIRST LOGIN)
INSERT INTO `users` (`name`, `email`, `password_hash`, `role`, `designation`, `status`, `must_change_password`)
VALUES ('System Admin', 'admin@company.com', '$2b$10$/TzgdzxirWPWO1IKMKxkaeBdDIER1PNGmAwsZdQOYyTVmUMMfZc7m', 'admin', 'Administrator', 'active', 0);

-- Modules
INSERT INTO `modules` (`id`, `name`, `slug`, `description`, `icon`, `sort_order`) VALUES
(1, 'HR', 'hr', 'Human Resources — employees, attendance, payroll, leave', 'users', 1),
(2, 'Sales', 'sales', 'Leads, deals, and sales reporting', 'trending-up', 2),
(3, 'Finance', 'finance', 'Invoices, expenses, and financial reports', 'wallet', 3),
(4, 'Recruitment', 'recruitment', 'Candidates, interviews, and offers', 'user-plus', 4),
(5, 'Operations', 'operations', 'Tasks, inventory, and operational reports', 'settings', 5);

-- Features: HR (module_id = 1)
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`) VALUES
(1, 'View Employees', 'hr.view_employees', 'View employee directory and profiles', 1),
(1, 'Manage Employees', 'hr.manage_employees', 'Add, edit, or remove employee records', 2),
(1, 'View Attendance', 'hr.view_attendance', 'View attendance and leave records', 3),
(1, 'Manage Attendance', 'hr.manage_attendance', 'Approve leave and edit attendance', 4),
(1, 'Manage Payroll', 'hr.manage_payroll', 'Process and manage employee payroll', 5),
(1, 'View HR Reports', 'hr.view_reports', 'View HR analytics and reports', 6);

-- Features: Sales (module_id = 2)
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`) VALUES
(2, 'View Sales Dashboard', 'sales.view_dashboard', 'View sales KPI dashboard and revenue forecast', 1),
(2, 'View Leads', 'sales.view_leads', 'View leads, follow-ups, won and lost deals', 2),
(2, 'Manage Leads', 'sales.manage_leads', 'Add, edit, or assign leads and update status', 3),
(2, 'View Companies', 'sales.view_companies', 'View target company / account database', 4),
(2, 'Manage Companies', 'sales.manage_companies', 'Add or edit company records', 5),
(2, 'View Meetings', 'sales.view_meetings', 'View scheduled and past meetings', 6),
(2, 'Manage Meetings', 'sales.manage_meetings', 'Schedule and log meeting outcomes', 7),
(2, 'View Quotations', 'sales.view_quotations', 'View quotations sent to clients', 8),
(2, 'Manage Quotations', 'sales.manage_quotations', 'Create and update quotations', 9),
(2, 'View Contracts', 'sales.view_contracts', 'View signed and active contracts', 10),
(2, 'Manage Contracts', 'sales.manage_contracts', 'Create and update contracts', 11),
  (2, 'Manage Client Onboarding', 'sales.manage_onboarding', 'Track and update client onboarding stages', 12),
  (2, 'Get Email Name', 'sales.get_email_name', 'Find publicly listed company emails by name and domain', 13);

-- Features: Finance (module_id = 3)
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`) VALUES
(3, 'View Invoices', 'finance.view_invoices', 'View invoices', 1),
(3, 'Manage Invoices', 'finance.manage_invoices', 'Create and edit invoices', 2),
(3, 'Approve Expenses', 'finance.approve_expenses', 'Approve or reject expense claims', 3),
(3, 'View Financial Reports', 'finance.view_reports', 'View financial statements and reports', 4);

-- Features: Recruitment (module_id = 4)
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`) VALUES
(4, 'View Candidates', 'recruitment.view_candidates', 'View candidate pipeline', 1),
(4, 'Manage Candidates', 'recruitment.manage_candidates', 'Add, edit, or reject candidates', 2),
(4, 'Schedule Interviews', 'recruitment.schedule_interviews', 'Schedule and manage interviews', 3),
(4, 'Manage Offers', 'recruitment.manage_offers', 'Create and send offer letters', 4);

-- Features: Operations (module_id = 5)
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`) VALUES
(5, 'View Tasks', 'operations.view_tasks', 'View operational tasks', 1),
(5, 'Manage Tasks', 'operations.manage_tasks', 'Assign and update tasks', 2),
(5, 'Manage Inventory', 'operations.manage_inventory', 'View and update inventory levels', 3),
(5, 'View Operations Reports', 'operations.view_reports', 'View operations analytics', 4);

-- -------------------------------------------------------------
-- Sample data: Sales CRM
-- -------------------------------------------------------------

INSERT INTO `sales_leads`
(`lead_code`, `lead_date`, `contact_person`, `contact_number`, `email`, `designation`, `lead_source`, `company_name`, `industry`, `website`, `company_email`, `country`, `status`, `lead_status`, `follow_up_date`, `last_contact_date`, `lead_health_score`, `remarks`, `created_by`) VALUES
('MLD-001', '2026-08-19', 'Sandeep Kumar', '6377809826', 'sandeep@muenot.co.in', 'Director', 'LinkedIn', 'Muenot', 'Ed-Tech', 'www.muenot.com', 'contact@muenot.co.in', 'India', 'Proposal Sent', 'Open', NULL, NULL, 10, NULL, 1),
('MLD-002', '2026-08-19', 'Ashutosh Garg', NULL, 'ashutosh@zeuslearning.com', 'Director', 'Referral', 'Zeus Learning', 'Ed-Tech', NULL, NULL, 'India', 'Proposal Sent', 'Open', '2026-09-05 10:21:30', '2026-08-21 10:21:30', 10, NULL, 1),
('MLD-003', '2026-08-19', 'Atul Gupta', '8800463339', 'atul.gupta@mheducation.com', 'VP Content', 'Website', 'McGraw-Hill Education', 'Ed-Tech', NULL, NULL, 'United States', 'In Discussion', 'Open', '2026-09-05 10:28:42', '2026-08-21 10:28:42', 50, NULL, 1),
('MLD-004', '2026-08-19', 'Bhavik Rathod', NULL, 'bhavik.rathod@scale.com', 'VP, Regional Head India', 'LinkedIn', 'Scale AI', 'AI Solutions', NULL, NULL, 'United States', 'Ready', 'Open', '2026-09-06 11:32:28', '2026-08-22 11:32:28', 0, NULL, 1),
('MLD-005', '2026-08-19', 'Manana Hakobyan', NULL, 'manana.hakobyan@scale.com', 'Strategic Projects Lead, Gen AI', 'LinkedIn', 'Scale AI', 'AI Solutions', NULL, NULL, 'United States', 'Ready', 'Open', '2026-09-06 11:42:52', '2026-08-22 11:42:52', 0, NULL, 1),
('MLD-021', '2026-08-20', 'Priya Nair', '9820011223', 'priya.nair@telusdigital.com', 'Project Coordinator', 'LinkedIn', 'Telus Digital', 'AI Solutions', NULL, NULL, 'Canada', 'Follow Up 1', 'Follow Up', '2026-09-10 09:00:00', '2026-08-25 09:00:00', 20, 'Interested in QA pilot', 1),
('MLD-022', '2026-08-21', 'Karan Mehta', NULL, 'karan.mehta@byjus.com', 'Head of Content', 'Website', 'BYJU''S', 'Ed-Tech', 'www.byjus.com', NULL, 'India', 'Follow Up 2', 'Follow Up', '2026-09-12 09:00:00', '2026-08-27 09:00:00', 35, NULL, 1),
('MLD-029', '2026-08-19', 'Anuj Mishra', '8605521578', 'anuj.mishra@hurix.com', 'Director, Projects', 'LinkedIn', 'HurixDigital', 'Ed-Tech', NULL, NULL, 'India', 'Won', 'Won', '2026-09-06 11:26:36', '2026-08-22 11:26:36', 100, 'Signed annual contract', 1),
('MLD-033', '2026-08-19', 'Reena Shah', 'NA', 'reena.shah@hurix.com', 'Vice President Delivery', 'LinkedIn', 'HurixDigital', 'Ed-Tech', NULL, NULL, 'India', 'Lost', 'Lost', NULL, NULL, 0, 'Budget frozen this quarter', 1),
('MLD-041', '2026-08-24', 'Vikram Singh', NULL, 'vikram.singh@multiverse.io', 'Head of Learning Ops', 'Referral', 'Multiverse', 'Ed-Tech', 'www.multiverse.io', NULL, 'United Kingdom', 'New', 'Open', NULL, NULL, 5, NULL, 1);

INSERT INTO `sales_companies`
(`company_code`, `company_date`, `company_name`, `industry`, `website`, `country`, `company_type`, `status`, `priority`, `founded_year`, `employee_count`, `created_by`) VALUES
('MCLD-001', '2026-07-29', 'Harmonic', 'AI Solutions', 'https://harmonic.fun/', 'Palo Alto, California, United States', 'Prospect', 'New', 'Medium', NULL, 200, 1),
('MCLD-002', '2026-07-29', 'Campus', 'Ed-Tech', NULL, 'New York, New York, United States', 'Prospect', 'New', 'Low', NULL, 500, 1),
('MCLD-003', '2026-07-29', 'Parallel Learning', 'Ed-Tech', 'https://www.parallellearning.com', 'New York, New York, United States', 'Prospect', 'Contacted', 'High', NULL, 100, 1),
('MCLD-004', '2026-07-29', 'Multiverse', 'Ed-Tech', 'https://www.multiverse.io', 'London, England, United Kingdom', 'Prospect', 'Qualified', 'High', NULL, NULL, 1),
('MCLD-005', '2026-07-29', 'D2L', 'Ed-Tech', 'https://www.d2l.com', 'Kitchener, Ontario, Canada', 'Prospect', 'New', 'Medium', NULL, NULL, 1);

INSERT INTO `sales_meetings`
(`meeting_code`, `meeting_date`, `meeting_time`, `company_name`, `contact_person`, `meeting_type`, `agenda`, `outcome_notes`, `next_steps`, `added_by`) VALUES
('MM-001', '2026-07-29', '10:00:00', 'Muenot', 'John Doe', 'Discovery', 'Discuss Q3 Upgrade', 'Positive response, wants demo', 'Schedule demo next week', 1),
('MM-002', '2026-07-29', '14:00:00', 'Zeus Learning', 'Ashutosh Garg', 'Demo', 'Showcase content delivery pipeline', 'Impressed but needs approval', 'Send proposal', 1),
('MM-003', '2026-08-25', '11:30:00', 'Scale AI', 'Bhavik Rathod', 'Negotiation', 'Review pricing and SLAs', 'Requested revised quote', 'Send revised quotation', 1);

INSERT INTO `sales_quotations`
(`quote_code`, `quote_date`, `company_name`, `contact_person`, `opportunity_name`, `total_amount`, `valid_until`, `status`, `added_by`) VALUES
('MQ-001', '2026-07-20', 'HurixDigital', 'Anuj Mishra', 'HurixDigital Annual Delivery Contract', 480000, '2026-08-20', 'Accepted', 1),
('MQ-002', '2026-07-29', 'Zeus Learning', 'Ashutosh Garg', 'Zeus Learning Content Delivery', 250000, '2026-08-22', 'Sent', 1),
('MQ-003', '2026-08-05', 'Scale AI', 'Bhavik Rathod', 'Scale AI Data Annotation Pilot', 500000, '2026-09-05', 'Draft', 1);

INSERT INTO `sales_contracts`
(`contract_code`, `contract_date`, `company_name`, `start_date`, `end_date`, `value`, `contract_type`, `status`, `signed_by_client`, `added_by`) VALUES
('CT-001', '2026-07-29', 'HurixDigital', '2026-08-01', '2027-07-31', 480000, 'Annual Delivery', 'Active', 'Anuj Mishra', 1),
('CT-002', '2026-06-01', 'Umbrella Learning Corp', '2026-06-15', '2027-06-14', 350000, 'Managed Services', 'Active', 'Alice Smith', 1);

INSERT INTO `sales_onboarding`
(`onboarding_code`, `onboarding_date`, `company_name`, `contract_code`, `start_date`, `kickoff_meeting_date`, `current_stage`, `status`, `onboarding_by`, `added_by`) VALUES
('OB-001', '2026-08-02', 'HurixDigital', 'CT-001', '2026-08-01', '2026-08-05', 'Training', 'In Progress', 'Sandeep Kumar', 1),
('OB-002', '2026-06-16', 'Umbrella Learning Corp', 'CT-002', '2026-06-15', '2026-06-20', 'Completed', 'Completed', 'Sandeep Kumar', 1);

INSERT INTO `sales_revenue_forecast`
(`forecast_code`, `forecast_date`, `quarter`, `year`, `expected_revenue`, `best_case`, `worst_case`, `pipeline_coverage`, `owner`, `added_by`) VALUES
('RF-001', '2026-07-01', 'Q3', 2026, 1500000, 2000000, 1000000, '3x', 'Sandeep Kumar', 1),
('RF-002', '2026-10-01', 'Q4', 2026, 1200000, 1500000, 900000, '2.5x', 'Sandeep Kumar', 1);


-- ==================== migrations/2026-08-30-add-email-features.sql ====================

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


-- ==================== migrations/2026-08-30-add-lead-status.sql ====================

-- =============================================================
-- Migration: Add `lead_status` column to sales_leads
-- Run this ONCE on your existing live database (phpMyAdmin -> SQL tab).
-- Safe to run even if some leads already exist — it backfills sensible
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


-- ==================== migrations/2026-08-31-add-environment-variables.sql ====================

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


-- ==================== migrations/2026-08-31-add-lead-source-url.sql ====================

ALTER TABLE `sales_leads`
  ADD COLUMN `source_url` VARCHAR(500) DEFAULT NULL AFTER `designation`;


-- ==================== migrations/2026-09-01-add-admin-settings.sql ====================

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


-- ==================== migrations/2026-09-01-add-automatic-record-ids.sql ====================

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


-- ==================== migrations/2026-09-01-add-clients-tickets-products.sql ====================

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


-- ==================== migrations/2026-09-01-add-email-template-attachments.sql ====================

ALTER TABLE sales_email_templates ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(500) NULL, ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL, ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL, ADD COLUMN IF NOT EXISTS attachment_size INT NULL;
ALTER TABLE hr_email_templates ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(500) NULL, ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL, ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL, ADD COLUMN IF NOT EXISTS attachment_size INT NULL;
ALTER TABLE finance_email_templates ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(500) NULL, ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL, ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL, ADD COLUMN IF NOT EXISTS attachment_size INT NULL;
ALTER TABLE operations_email_templates ADD COLUMN IF NOT EXISTS attachment_pathname VARCHAR(500) NULL, ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255) NULL, ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(150) NULL, ADD COLUMN IF NOT EXISTS attachment_size INT NULL;


-- ==================== migrations/2026-09-01-add-employee-documents.sql ====================

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


-- ==================== migrations/2026-09-01-add-finance-filing-features.sql ====================

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


-- ==================== migrations/2026-09-01-add-finance-module.sql ====================

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


-- ==================== migrations/2026-09-01-add-finance-operations-dashboard.sql ====================

-- Adds bank-reconciliation tracking to finance_records so the Finance Dashboard
-- can show a Reconciled / Unreconciled / Exception breakdown for bank transactions.
ALTER TABLE finance_records
  ADD COLUMN reconciliation_status ENUM('Reconciled','Unreconciled','Exception') DEFAULT NULL AFTER status;

-- Helpful index for the dashboard's "recent bank transactions" + reconciliation queries.
ALTER TABLE finance_records
  ADD INDEX idx_finance_reconciliation (module_key, reconciliation_status);


-- ==================== migrations/2026-09-01-add-finance-operations-emails.sql ====================

CREATE TABLE IF NOT EXISTS finance_email_templates (id BIGINT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(150) NOT NULL, subject VARCHAR(255) NOT NULL, body LONGTEXT NOT NULL, status ENUM('Active','Inactive') DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS operations_email_templates (id BIGINT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(150) NOT NULL, subject VARCHAR(255) NOT NULL, body LONGTEXT NOT NULL, status ENUM('Active','Inactive') DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS finance_emails (id BIGINT PRIMARY KEY AUTO_INCREMENT, to_email VARCHAR(320) NOT NULL, subject VARCHAR(255) NOT NULL, body LONGTEXT NOT NULL, status VARCHAR(30) DEFAULT 'Queued', sent_at DATETIME NULL, opened_at DATETIME NULL, created_by VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS operations_emails (id BIGINT PRIMARY KEY AUTO_INCREMENT, to_email VARCHAR(320) NOT NULL, subject VARCHAR(255) NOT NULL, body LONGTEXT NOT NULL, status VARCHAR(30) DEFAULT 'Queued', sent_at DATETIME NULL, opened_at DATETIME NULL, created_by VARCHAR(100), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);


-- ==================== migrations/2026-09-01-add-hr-attendance-regularisation.sql ====================

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


-- ==================== migrations/2026-09-01-add-hr-attendance.sql ====================

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


-- ==================== migrations/2026-09-01-add-hr-email-features.sql ====================

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


-- ==================== migrations/2026-09-01-add-hr-employees.sql ====================

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


-- ==================== migrations/2026-09-01-add-hr-leave-balances.sql ====================

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


-- ==================== migrations/2026-09-01-add-hr-leave-quota-history.sql ====================

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


-- ==================== migrations/2026-09-01-add-hr-leave-requests.sql ====================

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


-- ==================== migrations/2026-09-01-add-hr-leave-types.sql ====================

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


-- ==================== migrations/2026-09-01-add-hr-master-features.sql ====================

CREATE TABLE IF NOT EXISTS hr_departments (department_id VARCHAR(40) PRIMARY KEY, department_name VARCHAR(150) NOT NULL, parent_department_id VARCHAR(40), head_employee_id VARCHAR(40), description TEXT, status VARCHAR(30) NOT NULL DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_designations (designation_id VARCHAR(40) PRIMARY KEY, designation_name VARCHAR(150) NOT NULL, parent_designation_id VARCHAR(40), level_name VARCHAR(80), description TEXT, status VARCHAR(30) NOT NULL DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_promotions (promotion_id BIGINT AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT NOT NULL, effective_date DATE NOT NULL, old_designation_id VARCHAR(40), new_designation_id VARCHAR(40), old_department_id VARCHAR(40), new_department_id VARCHAR(40), old_grade VARCHAR(80), new_grade VARCHAR(80), old_salary DECIMAL(14,2), new_salary DECIMAL(14,2), reason TEXT, approved_by BIGINT, approver_name VARCHAR(150), status VARCHAR(30) DEFAULT 'Pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_awards (award_id BIGINT AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT NOT NULL, award_name VARCHAR(180) NOT NULL, award_date DATE NOT NULL, given_by VARCHAR(150), description TEXT, badge_url VARCHAR(500), status VARCHAR(30) DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_appreciations (appreciation_id BIGINT AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT NOT NULL, title VARCHAR(180) NOT NULL, message TEXT NOT NULL, given_by VARCHAR(150), appreciation_date DATE NOT NULL, category VARCHAR(80), status VARCHAR(30) DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_passport_visa (record_id BIGINT AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT NOT NULL, passport_number VARCHAR(80), passport_issue_date DATE, passport_expiry_date DATE, visa_type VARCHAR(80), visa_number VARCHAR(80), visa_issue_date DATE, visa_expiry_date DATE, country VARCHAR(100), status VARCHAR(30) DEFAULT 'Active', passport_path VARCHAR(500), visa_path VARCHAR(500), remarks TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS hr_holidays (holiday_id BIGINT AUTO_INCREMENT PRIMARY KEY, holiday_name VARCHAR(180) NOT NULL, holiday_date DATE NOT NULL, holiday_type VARCHAR(80), applicable_department_id VARCHAR(40), applicable_state_ut VARCHAR(100), optional TINYINT(1) DEFAULT 0, description TEXT, status VARCHAR(30) DEFAULT 'Active', year INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
INSERT IGNORE INTO modules (name, slug, description, icon, sort_order) SELECT 'HR', 'hr', 'People operations', 'users', 1 FROM dual WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug='hr');
INSERT IGNORE INTO features (module_id,name,slug,sort_order) SELECT id,'HR Master Data','hr.view_master_data',30 FROM modules WHERE slug='hr';


-- ==================== migrations/2026-09-01-add-hr-offboarding.sql ====================

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


-- ==================== migrations/2026-09-01-add-hr-shift-workflows.sql ====================

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


-- ==================== migrations/2026-09-01-add-hr-shifts.sql ====================

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


-- ==================== migrations/2026-09-01-add-hr-support.sql ====================

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


-- ==================== migrations/2026-09-01-add-messaging.sql ====================

CREATE TABLE IF NOT EXISTS message_permissions (id INT AUTO_INCREMENT PRIMARY KEY, employee_id INT NOT NULL, can_message_employees BOOLEAN NOT NULL DEFAULT TRUE, can_message_admins BOOLEAN NOT NULL DEFAULT TRUE, can_message_management BOOLEAN NOT NULL DEFAULT TRUE, allowed_department VARCHAR(120) NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uq_message_permission_employee (employee_id));
CREATE TABLE IF NOT EXISTS conversations (id INT AUTO_INCREMENT PRIMARY KEY, subject VARCHAR(200) NULL, created_by INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS conversation_participants (conversation_id INT NOT NULL, user_id INT NOT NULL, last_read_at DATETIME NULL, PRIMARY KEY (conversation_id, user_id));
CREATE TABLE IF NOT EXISTS messages (id INT AUTO_INCREMENT PRIMARY KEY, conversation_id INT NOT NULL, sender_id INT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_messages_conversation (conversation_id, created_at));
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order) SELECT id,'Messages','messages.view','View and use internal messaging',90 FROM modules WHERE slug='messages';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order) SELECT id,'Message permissions','messages.manage_permissions','Manage employee messaging controls',91 FROM modules WHERE slug='messages';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order) SELECT id,'Messaging','messages.send','Send internal messages',92 FROM modules WHERE slug='messages';
ALTER TABLE messages ADD CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE conversation_participants ADD CONSTRAINT fk_cp_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;


-- ==================== migrations/2026-09-01-add-operations-module.sql ====================

CREATE TABLE IF NOT EXISTS operations_resources (resource_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT UNSIGNED NULL, resource_name VARCHAR(160) NOT NULL, resource_type ENUM('FTE','Freelancer','Contractor') NOT NULL DEFAULT 'FTE', skill_set VARCHAR(255), capacity_hours DECIMAL(8,2) NOT NULL DEFAULT 160, status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active', notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, INDEX idx_ops_resource_status(status));
CREATE TABLE IF NOT EXISTS operations_projects (project_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_name VARCHAR(190) NOT NULL, client_name VARCHAR(190), manager_name VARCHAR(160), start_date DATE, end_date DATE, status ENUM('Planned','Active','On Hold','Completed','Cancelled') NOT NULL DEFAULT 'Planned', priority ENUM('Low','Medium','High','Critical') NOT NULL DEFAULT 'Medium', sla_due_date DATE, description TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS operations_allocations (allocation_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL, resource_id BIGINT UNSIGNED NOT NULL, allocation_percent DECIMAL(5,2) NOT NULL DEFAULT 100, from_date DATE NOT NULL, to_date DATE, status ENUM('Planned','Active','Released') NOT NULL DEFAULT 'Planned', assigned_by VARCHAR(160), notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(project_id), INDEX(resource_id));
CREATE TABLE IF NOT EXISTS operations_quality_reviews (review_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NULL, resource_id BIGINT UNSIGNED NULL, review_date DATE NOT NULL, quality_score DECIMAL(5,2), sla_score DECIMAL(5,2), status ENUM('Open','Passed','Needs Improvement') NOT NULL DEFAULT 'Open', reviewer_name VARCHAR(160), remarks TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS operations_issues (issue_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NULL, resource_id BIGINT UNSIGNED NULL, title VARCHAR(190) NOT NULL, description TEXT, priority ENUM('Low','Medium','High','Critical') NOT NULL DEFAULT 'Medium', status ENUM('Open','In Progress','Resolved','Closed') NOT NULL DEFAULT 'Open', assigned_to VARCHAR(160), due_date DATE, resolved_at DATETIME NULL, remarks TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
INSERT IGNORE INTO modules(name,slug,description,icon,sort_order) SELECT 'Operations','operations','Resources, projects, allocations, quality, and delivery operations.','briefcase',2 FROM dual WHERE NOT EXISTS(SELECT 1 FROM modules WHERE slug='operations');
INSERT IGNORE INTO features(module_id,name,slug,description,sort_order) SELECT id,'Operations','operations.view_dashboard','View operations module',1 FROM modules WHERE slug='operations';


-- ==================== migrations/2026-09-01-add-workspace-modules.sql ====================

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

