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
