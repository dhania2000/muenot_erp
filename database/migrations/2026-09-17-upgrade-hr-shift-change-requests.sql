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
