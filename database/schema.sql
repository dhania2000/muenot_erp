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
  `lead_source` VARCHAR(80) DEFAULT NULL,
  `company_name` VARCHAR(190) DEFAULT NULL,
  `industry` VARCHAR(100) DEFAULT NULL,
  `website` VARCHAR(190) DEFAULT NULL,
  `company_email` VARCHAR(190) DEFAULT NULL,
  `country` VARCHAR(100) DEFAULT NULL,
  `assigned_to` INT UNSIGNED DEFAULT NULL,
  `status` ENUM('New','Follow Up 1','Follow Up 2','In Discussion','Proposal Sent','Ready','Won','Lost') NOT NULL DEFAULT 'New',
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
(2, 'Manage Client Onboarding', 'sales.manage_onboarding', 'Track and update client onboarding stages', 12);

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
(`lead_code`, `lead_date`, `contact_person`, `contact_number`, `email`, `designation`, `lead_source`, `company_name`, `industry`, `website`, `company_email`, `country`, `status`, `follow_up_date`, `last_contact_date`, `lead_health_score`, `remarks`, `created_by`) VALUES
('MLD-001', '2026-08-19', 'Sandeep Kumar', '6377809826', 'sandeep@muenot.co.in', 'Director', 'LinkedIn', 'Muenot', 'Ed-Tech', 'www.muenot.com', 'contact@muenot.co.in', 'India', 'Proposal Sent', NULL, NULL, 10, NULL, 1),
('MLD-002', '2026-08-19', 'Ashutosh Garg', NULL, 'ashutosh@zeuslearning.com', 'Director', 'Referral', 'Zeus Learning', 'Ed-Tech', NULL, NULL, 'India', 'Proposal Sent', '2026-09-05 10:21:30', '2026-08-21 10:21:30', 10, NULL, 1),
('MLD-003', '2026-08-19', 'Atul Gupta', '8800463339', 'atul.gupta@mheducation.com', 'VP Content', 'Website', 'McGraw-Hill Education', 'Ed-Tech', NULL, NULL, 'United States', 'In Discussion', '2026-09-05 10:28:42', '2026-08-21 10:28:42', 50, NULL, 1),
('MLD-004', '2026-08-19', 'Bhavik Rathod', NULL, 'bhavik.rathod@scale.com', 'VP, Regional Head India', 'LinkedIn', 'Scale AI', 'AI Solutions', NULL, NULL, 'United States', 'Ready', '2026-09-06 11:32:28', '2026-08-22 11:32:28', 0, NULL, 1),
('MLD-005', '2026-08-19', 'Manana Hakobyan', NULL, 'manana.hakobyan@scale.com', 'Strategic Projects Lead, Gen AI', 'LinkedIn', 'Scale AI', 'AI Solutions', NULL, NULL, 'United States', 'Ready', '2026-09-06 11:42:52', '2026-08-22 11:42:52', 0, NULL, 1),
('MLD-021', '2026-08-20', 'Priya Nair', '9820011223', 'priya.nair@telusdigital.com', 'Project Coordinator', 'LinkedIn', 'Telus Digital', 'AI Solutions', NULL, NULL, 'Canada', 'Follow Up 1', '2026-09-10 09:00:00', '2026-08-25 09:00:00', 20, 'Interested in QA pilot', 1),
('MLD-022', '2026-08-21', 'Karan Mehta', NULL, 'karan.mehta@byjus.com', 'Head of Content', 'Website', 'BYJU''S', 'Ed-Tech', 'www.byjus.com', NULL, 'India', 'Follow Up 2', '2026-09-12 09:00:00', '2026-08-27 09:00:00', 35, NULL, 1),
('MLD-029', '2026-08-19', 'Anuj Mishra', '8605521578', 'anuj.mishra@hurix.com', 'Director, Projects', 'LinkedIn', 'HurixDigital', 'Ed-Tech', NULL, NULL, 'India', 'Won', '2026-09-06 11:26:36', '2026-08-22 11:26:36', 100, 'Signed annual contract', 1),
('MLD-033', '2026-08-19', 'Reena Shah', 'NA', 'reena.shah@hurix.com', 'Vice President Delivery', 'LinkedIn', 'HurixDigital', 'Ed-Tech', NULL, NULL, 'India', 'Lost', NULL, NULL, 0, 'Budget frozen this quarter', 1),
('MLD-041', '2026-08-24', 'Vikram Singh', NULL, 'vikram.singh@multiverse.io', 'Head of Learning Ops', 'Referral', 'Multiverse', 'Ed-Tech', 'www.multiverse.io', NULL, 'United Kingdom', 'New', NULL, NULL, 5, NULL, 1);

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
