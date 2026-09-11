-- ---------------------------------------------------------------------------
-- HR Support → full internal HR Helpdesk / Case Management.
--
-- This migration brings the persisted schema in line with the runtime
-- self-heal in lib/hr-support.ts (ensureSupportSchema). It is additive and
-- idempotent: every new column is nullable/defaulted so historical tickets and
-- the original clock-in/POST paths keep working unchanged. Running it is
-- optional — the app self-heals the same schema on first request — but keeping
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

-- Activity timeline / audit trail (created, assigned, status, SLA, reopen…).
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
