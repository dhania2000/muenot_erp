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
