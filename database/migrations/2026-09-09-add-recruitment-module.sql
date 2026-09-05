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
