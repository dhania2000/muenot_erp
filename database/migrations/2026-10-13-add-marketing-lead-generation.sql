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
